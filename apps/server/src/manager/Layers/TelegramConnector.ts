/**
 * TelegramConnector - Telegram ingress/egress for assistants.
 *
 * Every assistant project may own its own bot: the poller iterates all
 * configured `telegram` connector rows each cycle, long-polls each bot, and
 * routes messages from allowlisted chats into that assistant's chat threads.
 * Incoming media is downloaded: images enter the chat attachment pipeline
 * (vision), voice/video/documents are saved to disk and described to the
 * harness by absolute path. When the turn completes (or its harness session
 * dies mid-turn), the last assistant message goes back to the chat; files the
 * assistant marked with `[[send-file: /abs/path]]` are uploaded alongside it.
 *
 * Thread lifecycle per chat: one thread per (project, chatId), reused while it
 * stays alive AND still matches the connector's configured harness/model.
 * Changing the default selection (or archiving the thread) makes the next
 * message start a fresh thread on the new selection, seeded with a compact
 * transcript of the previous one.
 *
 * Config lives in `manager_assistant_connectors` and is re-read between poll
 * cycles, so saving settings takes effect without a restart.
 */
import {
  CommandId,
  ManagerTelegramConnectorConfig,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  type ChatImageAttachment,
  type ModelSelection,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Context, Data, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorRepository } from "../../persistence/Services/ManagerConnectors.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../../persistence/Services/ProjectionTurns.ts";
import {
  buildMediaFailureNote,
  buildMediaNote,
  collectTelegramMedia,
  describeNonFileContent,
  extractOutgoingFiles,
  isImageLikeMedia,
  pickTelegramUploadMethod,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
  TELEGRAM_BOT_UPLOAD_LIMIT_BYTES,
  TELEGRAM_SEND_FILE_HINT,
  type TelegramIncomingMessage,
  type TelegramMediaDescriptor,
} from "../telegramMedia.ts";

export interface ManagerTelegramRuntimeStatus {
  readonly botUsername: string | null;
  readonly lastError: string | null;
}

export interface ManagerTelegramServiceShape {
  readonly getRuntimeStatus: (
    projectId: ProjectId,
  ) => Effect.Effect<ManagerTelegramRuntimeStatus>;
}

export class ManagerTelegramService extends Context.Service<
  ManagerTelegramService,
  ManagerTelegramServiceShape
>()("t3/manager/Services/ManagerTelegramService") {}

const POLL_TIMEOUT_SECONDS = 10;
const IDLE_RECHECK = Duration.seconds(5);
const REPLY_POLL_INTERVAL = Duration.seconds(2);
const REPLY_TIMEOUT = Duration.minutes(10);
// Hermes (ACP) резолвит session/prompt раньше, чем достримит текст ответа:
// turn в проекции уже терминален, а сообщение ассистента приходит секундами
// позже. Терминальному turn'у без текста даём этот grace-период на дозапись
// сообщения, прежде чем сдаться и отправить "Turn finished with state".
const TERMINAL_REPLY_GRACE = Duration.seconds(45);
const TELEGRAM_MESSAGE_LIMIT = 4000;
// When the chat is re-pointed at a new thread (harness switch, archived
// thread), this many recent messages of the old thread are carried over as a
// context preamble on the first turn.
const HANDOFF_MESSAGE_COUNT = 12;
const HANDOFF_MESSAGE_CHARS = 600;
// Session statuses that mean the harness runtime is gone and the turn will
// never reach a terminal state on its own.
const DEAD_SESSION_STATUSES: ReadonlySet<string> = new Set(["stopped", "error"]);

// Markers wrapping the handoff preamble on the first message of a replacement
// thread. `stripHandoffPreamble` relies on them so that re-pointing the chat
// again does not nest preambles inside preambles.
const HANDOFF_PREAMBLE_START =
  "[Context: this Telegram chat previously ran in another thread (the harness/model was switched). Recent history, oldest first:]";
const HANDOFF_PREAMBLE_END = "[End of context. Reply to the message below.]";

export const stripHandoffPreamble = (text: string): string => {
  if (!text.startsWith(HANDOFF_PREAMBLE_START)) {
    return text;
  }
  const endIndex = text.indexOf(HANDOFF_PREAMBLE_END);
  if (endIndex === -1) {
    return text;
  }
  return text.slice(endIndex + HANDOFF_PREAMBLE_END.length).replace(/^\s+/, "");
};

export interface TurnReplyInputs {
  readonly turns: ReadonlyArray<
    Pick<ProjectionTurn, "turnId" | "state" | "requestedAt" | "completedAt">
  >;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly streaming: boolean;
    readonly createdAt: string;
  }>;
  readonly sessionStatus: string | null;
  /** When `sessionStatus` was written; stale rows predate this request. */
  readonly sessionUpdatedAtIso: string | null;
  readonly requestedAtIso: string;
  /** Wall-clock of the current poll; keeps the grace-period logic pure. */
  readonly nowIso: string;
}

export interface ResolvedTurnReply {
  /** Chat text, already truncated; may be empty when the reply is file-only. */
  readonly text: string;
  /** Absolute paths the assistant marked with `[[send-file: …]]`. */
  readonly files: ReadonlyArray<string>;
}

// Decides what (if anything) to send back to the chat for the turn requested
// at `requestedAtIso`. Returns null while the turn is still in flight.
//
// The turn state is read from the turn rows, NOT from the thread shell's
// `latestTurn`: that field mirrors `projection_threads.latest_turn_id`, which
// tracks the session's active turn and is nulled the moment the session goes
// idle again (it only survives for threads that produce checkpoint diffs), so
// a 2s poller essentially never observes a terminal state through it.
export const resolveTurnReply = (input: TurnReplyInputs): ResolvedTurnReply | null => {
  const turn =
    [...input.turns]
      .filter(
        (candidate) =>
          candidate.turnId !== null && candidate.requestedAt >= input.requestedAtIso,
      )
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
      .at(0) ?? null;
  // «stopped»/«error», записанные ДО этого запроса — протухший статус прошлого
  // запуска приложения: dispatch как раз (пере)поднимает сессию. Смертью
  // считаем только статус, проставленный после requestedAtIso.
  const sessionDied =
    input.sessionStatus !== null &&
    DEAD_SESSION_STATUSES.has(input.sessionStatus) &&
    (input.sessionUpdatedAtIso === null || input.sessionUpdatedAtIso >= input.requestedAtIso);
  const stillRunning =
    turn === null || turn.state === "pending" || turn.state === "running";
  if (stillRunning && !sessionDied) {
    return null;
  }
  const lastAssistantMessage = [...input.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        !message.streaming &&
        message.createdAt >= input.requestedAtIso &&
        message.text.trim().length > 0,
    );
  if (lastAssistantMessage !== undefined) {
    const { text, files } = extractOutgoingFiles(lastAssistantMessage.text);
    return { text: text.slice(0, TELEGRAM_MESSAGE_LIMIT), files };
  }
  // Turn терминален, а текста ещё нет: если сессия жива, подождём — харнесс
  // может дописать сообщение после завершения turn'а (hermes так делает всегда).
  if (!stillRunning && !sessionDied) {
    const terminalAtIso = turn?.completedAt ?? turn?.requestedAt ?? input.requestedAtIso;
    const graceEndsAtMs =
      new Date(terminalAtIso).getTime() + Duration.toMillis(TERMINAL_REPLY_GRACE);
    if (new Date(input.nowIso).getTime() < graceEndsAtMs) {
      return null;
    }
  }
  return {
    text: stillRunning
      ? "The harness session ended before finishing this turn; check the app for details."
      : `Turn finished with state: ${turn.state}.`,
    files: [],
  };
};

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramIncomingMessage;
}

interface BotRuntime {
  offset: number;
  botUsername: string | null;
  lastError: string | null;
}

function telegramApi(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${botToken}/${method}`;
}

/** Ошибка Telegram Bot API / файловой системы — только сообщение, поллер её логирует. */
class TelegramConnectorError extends Data.TaggedError("TelegramConnectorError")<{
  readonly message: string;
}> {}

const fetchJson = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, init);
      return (await response.json()) as { ok?: boolean; result?: unknown; description?: string };
    },
    catch: (cause) =>
      new TelegramConnectorError({ message: `Telegram request failed: ${String(cause)}` }),
  });

const makeTelegramConnector = Effect.gen(function* () {
  const connectorRepository = yield* ManagerConnectorRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverConfig = yield* ServerConfig;

  // Non-image incoming files land here; the harness reads them by absolute
  // path (Telegram threads always run in full-access mode).
  const telegramFilesDir = nodePath.join(serverConfig.stateDir, "telegram-files");

  const runtimesRef = yield* Ref.make<ReadonlyMap<ProjectId, BotRuntime>>(new Map());

  const updateRuntime = (projectId: ProjectId, patch: Partial<BotRuntime>) =>
    Ref.update(runtimesRef, (runtimes) => {
      const next = new Map(runtimes);
      const current = next.get(projectId) ?? { offset: 0, botUsername: null, lastError: null };
      next.set(projectId, { ...current, ...patch });
      return next;
    });

  const getRuntime = (projectId: ProjectId) =>
    Ref.get(runtimesRef).pipe(
      Effect.map(
        (runtimes) =>
          runtimes.get(projectId) ?? { offset: 0, botUsername: null, lastError: null },
      ),
    );

  const sameHarnessAndModel = (a: ModelSelection, b: ModelSelection): boolean =>
    a.instanceId === b.instanceId && a.model === b.model;

  // Compact transcript of the old thread, carried into the replacement thread
  // as a preamble on its first turn so the new harness knows what came before.
  const buildHandoffContext = (thread: OrchestrationThread): string | null => {
    const recent = thread.messages
      .filter(
        (message) =>
          (message.role === "user" || message.role === "assistant") &&
          !message.streaming &&
          message.text.trim().length > 0,
      )
      .slice(-HANDOFF_MESSAGE_COUNT);
    if (recent.length === 0) {
      return null;
    }
    const lines = recent.flatMap((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      // If the old thread itself started from a handoff, its first user
      // message carries a preamble of the thread before it. Strip it, or
      // rapid harness switches nest preambles inside preambles. The standing
      // send-file hint is connector plumbing, not conversation — drop it too.
      const withoutPreamble = stripHandoffPreamble(message.text).replace(
        TELEGRAM_SEND_FILE_HINT,
        "",
      );
      if (withoutPreamble.trim().length === 0) {
        return [];
      }
      const text =
        withoutPreamble.length > HANDOFF_MESSAGE_CHARS
          ? `${withoutPreamble.slice(0, HANDOFF_MESSAGE_CHARS)}…`
          : withoutPreamble;
      return [`${role}: ${text}`];
    });
    return lines.length === 0 ? null : lines.join("\n");
  };

  const ensureThreadForChat = (input: {
    readonly projectId: ProjectId;
    readonly chatId: string;
    readonly chatLabel: string;
    readonly config: ManagerTelegramConnectorConfig;
  }) =>
    Effect.gen(function* () {
      const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId);
      // The connector-level choice wins: Telegram must never spawn a harness
      // the owner didn't pick for it.
      const modelSelection =
        input.config.defaultModelSelection ??
        (Option.isSome(project) ? project.value.defaultModelSelection : null);

      const existing = yield* connectorRepository.getThreadForChat({
        projectId: input.projectId,
        kind: "telegram",
        chatId: input.chatId,
      });
      let previousThreadId: ThreadId | null = null;
      if (Option.isSome(existing)) {
        const shell = yield* projectionSnapshotQuery.getThreadShellById(existing.value);
        if (Option.isSome(shell) && shell.value.archivedAt === null) {
          // Reuse the live thread unless the owner has since pointed the
          // connector at a different harness/model — then start a fresh
          // thread on the new selection instead of silently ignoring it.
          if (
            modelSelection === null ||
            sameHarnessAndModel(shell.value.modelSelection, modelSelection)
          ) {
            return { threadId: existing.value, handoffContext: null };
          }
        }
        previousThreadId = existing.value;
      }
      if (modelSelection === null) {
        return yield* Effect.fail(new Error("Assistant project has no model configured."));
      }

      let handoffContext: string | null = null;
      if (previousThreadId !== null) {
        const previousDetail = yield* projectionSnapshotQuery
          .getThreadDetailById(previousThreadId)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));
        if (Option.isSome(previousDetail)) {
          handoffContext = buildHandoffContext(previousDetail.value);
        }
      }

      const threadId = ThreadId.make(crypto.randomUUID());
      const createdAt = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`telegram:${crypto.randomUUID()}`),
        threadId,
        projectId: input.projectId,
        title: `Telegram: ${input.chatLabel}`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* connectorRepository.setThreadForChat({
        projectId: input.projectId,
        kind: "telegram",
        chatId: input.chatId,
        threadId,
        createdAt,
      });
      return { threadId, handoffContext };
    });

  // Send a message and surface Telegram-side rejections into the log instead
  // of silently dropping them.
  const sendTelegramText = (botToken: string, chatId: string, text: string) =>
    fetchJson(telegramApi(botToken, "sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).pipe(
      Effect.tap((response) =>
        response.ok === true
          ? Effect.void
          : Effect.logWarning("telegram sendMessage rejected").pipe(
              Effect.annotateLogs({
                chatId,
                description: response.description ?? "unknown error",
              }),
            ),
      ),
    );

  // Resolve a Telegram file_id to raw bytes: getFile → file download endpoint.
  const downloadTelegramFile = (botToken: string, fileId: string) =>
    Effect.gen(function* () {
      const fileInfo = yield* fetchJson(
        telegramApi(botToken, "getFile") + `?file_id=${encodeURIComponent(fileId)}`,
      );
      if (fileInfo.ok !== true) {
        return yield* Effect.fail(new Error(fileInfo.description ?? "getFile failed"));
      }
      const filePath = (fileInfo.result as { file_path?: string } | undefined)?.file_path;
      if (filePath === undefined) {
        return yield* Effect.fail(new Error("getFile returned no file_path"));
      }
      return yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
          if (!response.ok) {
            throw new Error(`file download failed with status ${response.status}`);
          }
          return new Uint8Array(await response.arrayBuffer());
        },
        catch: (cause) =>
          new TelegramConnectorError({ message: `Telegram file download failed: ${String(cause)}` }),
      });
    });

  // Download every media payload of an incoming message. Images become chat
  // attachments (the harness sees them as vision inputs); everything else is
  // saved under `telegram-files/<chatId>/` and described to the harness as a
  // bracketed note with the absolute path. Failures degrade to notes too — the
  // turn still runs so the user gets an answer instead of silence.
  const ingestIncomingMedia = (input: {
    readonly botToken: string;
    readonly threadId: ThreadId;
    readonly chatId: string;
    readonly media: ReadonlyArray<TelegramMediaDescriptor>;
  }) =>
    Effect.gen(function* () {
      const attachments: Array<ChatImageAttachment> = [];
      const notes: Array<string> = [];
      for (const descriptor of input.media) {
        if (
          descriptor.sizeBytes !== null &&
          descriptor.sizeBytes > TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES
        ) {
          notes.push(
            buildMediaFailureNote(
              descriptor,
              "the file exceeds the 20 MB Telegram bot download limit; ask the user to share it another way (e.g. a link)",
            ),
          );
          continue;
        }
        const downloaded = yield* downloadTelegramFile(input.botToken, descriptor.fileId).pipe(
          Effect.map((bytes) => ({ ok: true as const, bytes })),
          Effect.catch((cause) =>
            Effect.succeed({
              ok: false as const,
              reason: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
        );
        if (!downloaded.ok) {
          notes.push(buildMediaFailureNote(descriptor, downloaded.reason));
          continue;
        }
        const bytes = downloaded.bytes;

        if (
          isImageLikeMedia(descriptor) &&
          descriptor.mimeType !== null &&
          bytes.byteLength > 0 &&
          bytes.byteLength <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES &&
          attachments.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS
        ) {
          const attachmentId = createAttachmentId(input.threadId);
          if (attachmentId !== null) {
            const attachment = {
              type: "image" as const,
              id: attachmentId,
              name: descriptor.fileName,
              mimeType: descriptor.mimeType.toLowerCase(),
              sizeBytes: bytes.byteLength,
            } satisfies ChatImageAttachment;
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (attachmentPath !== null) {
              const stored = yield* Effect.tryPromise({
                try: async () => {
                  await fsPromises.mkdir(nodePath.dirname(attachmentPath), { recursive: true });
                  await fsPromises.writeFile(attachmentPath, bytes);
                },
                catch: (cause) => new TelegramConnectorError({ message: String(cause) }),
              }).pipe(
                Effect.map(() => true),
                Effect.catch((cause) =>
                  Effect.logWarning("telegram image attachment write failed").pipe(
                    Effect.annotateLogs({ chatId: input.chatId, cause }),
                    Effect.map(() => false),
                  ),
                ),
              );
              if (stored) {
                attachments.push(attachment);
                continue;
              }
            }
          }
        }

        const directory = nodePath.join(telegramFilesDir, input.chatId);
        const savedPath = nodePath.join(
          directory,
          `${crypto.randomUUID().slice(0, 8)}-${descriptor.fileName}`,
        );
        const saved = yield* Effect.tryPromise({
          try: async () => {
            await fsPromises.mkdir(directory, { recursive: true });
            await fsPromises.writeFile(savedPath, bytes);
          },
          catch: (cause) => new TelegramConnectorError({ message: String(cause) }),
        }).pipe(
          Effect.map(() => true),
          Effect.catch((cause) =>
            Effect.logWarning("telegram media save failed").pipe(
              Effect.annotateLogs({ chatId: input.chatId, savedPath, cause }),
              Effect.map(() => false),
            ),
          ),
        );
        notes.push(
          saved
            ? buildMediaNote(descriptor, savedPath)
            : buildMediaFailureNote(descriptor, "failed to save the file on the server"),
        );
      }
      return { attachments, notes };
    });

  // Upload a file the assistant marked with `[[send-file: …]]`. Photos go via
  // sendPhoto (with a sendDocument fallback: Telegram rejects photos over its
  // dimension limits), everything else via sendDocument. Failures are reported
  // into the chat so the user isn't left waiting for a file that never comes.
  const sendTelegramFile = (botToken: string, chatId: string, filePath: string) =>
    Effect.gen(function* () {
      const failure = yield* Effect.tryPromise({
        try: async () => {
          const stat = await fsPromises.stat(filePath);
          if (!stat.isFile()) {
            throw new Error("not a regular file");
          }
          if (stat.size > TELEGRAM_BOT_UPLOAD_LIMIT_BYTES) {
            throw new Error("file exceeds the 50 MB Telegram bot upload limit");
          }
          const bytes = await fsPromises.readFile(filePath);
          const fileName = nodePath.basename(filePath);
          const upload = async (method: string, field: string) => {
            const form = new FormData();
            form.append("chat_id", chatId);
            form.append(field, new Blob([new Uint8Array(bytes)]), fileName);
            const response = await fetch(telegramApi(botToken, method), {
              method: "POST",
              body: form,
            });
            return (await response.json()) as { ok?: boolean; description?: string };
          };
          const preferred = pickTelegramUploadMethod(fileName);
          let result = await upload(preferred.method, preferred.field);
          if (result.ok !== true && preferred.method === "sendPhoto") {
            result = await upload("sendDocument", "document");
          }
          if (result.ok !== true) {
            throw new Error(result.description ?? "upload rejected by Telegram");
          }
        },
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.map(() => null),
        Effect.catch((reason) => Effect.succeed(reason)),
      );
      if (failure !== null) {
        yield* Effect.logWarning("telegram file upload failed").pipe(
          Effect.annotateLogs({ chatId, filePath, description: failure }),
        );
        yield* sendTelegramText(botToken, chatId, `Could not send ${filePath}: ${failure}`);
      }
    });

  const sendReplyWhenTurnCompletes = (input: {
    readonly botToken: string;
    readonly chatId: string;
    readonly threadId: ThreadId;
    readonly requestedAtIso: string;
  }) =>
    Effect.gen(function* () {
      const deadline = Date.now() + Duration.toMillis(REPLY_TIMEOUT);
      while (Date.now() < deadline) {
        yield* Effect.sleep(REPLY_POLL_INTERVAL);
        const detail = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId);
        if (Option.isNone(detail)) continue;
        const turns = yield* projectionTurnRepository.listByThreadId({
          threadId: input.threadId,
        });
        const reply = resolveTurnReply({
          turns,
          messages: detail.value.messages,
          sessionStatus: detail.value.session?.status ?? null,
          sessionUpdatedAtIso: detail.value.session?.updatedAt ?? null,
          requestedAtIso: input.requestedAtIso,
          nowIso: new Date().toISOString(),
        });
        if (reply === null) continue;
        if (reply.text.trim().length > 0) {
          yield* sendTelegramText(input.botToken, input.chatId, reply.text);
        } else if (reply.files.length === 0) {
          yield* sendTelegramText(input.botToken, input.chatId, "Done.");
        }
        for (const file of reply.files) {
          yield* sendTelegramFile(input.botToken, input.chatId, file);
        }
        return;
      }
      yield* sendTelegramText(
        input.botToken,
        input.chatId,
        "The assistant is still working on it; check the app for progress.",
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("telegram reply watcher failed").pipe(
          Effect.annotateLogs({ chatId: input.chatId, cause }),
        ),
      ),
    );

  const handleUpdate = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    update: TelegramUpdate,
  ) =>
    Effect.gen(function* () {
      const message = update.message;
      const chatIdNumber = message?.chat?.id;
      if (message === undefined || chatIdNumber === undefined) {
        return;
      }
      const text = (message.text ?? message.caption ?? "").trim();
      const media = collectTelegramMedia(message);
      const nonFileLines = describeNonFileContent(message);
      if (text.length === 0 && media.length === 0 && nonFileLines.length === 0) {
        return;
      }
      const chatId = String(chatIdNumber);
      if (!config.allowedChatIds.includes(chatId)) {
        yield* Effect.logDebug("telegram message from non-allowlisted chat ignored").pipe(
          Effect.annotateLogs({ projectId, chatId }),
        );
        return;
      }
      const chatLabel = message.chat?.title ?? message.chat?.username ?? chatId;
      const { threadId, handoffContext } = yield* ensureThreadForChat({
        projectId,
        chatId,
        chatLabel,
        config,
      });
      const ingested =
        media.length > 0
          ? yield* ingestIncomingMedia({ botToken: config.botToken, threadId, chatId, media })
          : { attachments: [], notes: [] };
      const bodyParts = [text, ...nonFileLines, ...ingested.notes].filter(
        (part) => part.length > 0,
      );
      if (bodyParts.length === 0) {
        bodyParts.push("[The user sent the attached image(s) without a caption.]");
      }
      const body = [...bodyParts, TELEGRAM_SEND_FILE_HINT].join("\n\n");
      const messageText =
        handoffContext === null
          ? body
          : [HANDOFF_PREAMBLE_START, handoffContext, HANDOFF_PREAMBLE_END, "", body].join(
              "\n",
            );
      const requestedAtIso = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`telegram:${crypto.randomUUID()}`),
        threadId,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text: messageText,
          attachments: ingested.attachments,
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: requestedAtIso,
      });
      yield* Effect.forkScoped(
        sendReplyWhenTurnCompletes({
          botToken: config.botToken,
          chatId,
          threadId,
          requestedAtIso,
        }),
      );
    });

  const pollConnector = (projectId: ProjectId, config: ManagerTelegramConnectorConfig) =>
    Effect.gen(function* () {
      const runtime = yield* getRuntime(projectId);
      if (runtime.botUsername === null) {
        const me = yield* fetchJson(telegramApi(config.botToken, "getMe"));
        if (me.ok === true) {
          const username = (me.result as { username?: string } | undefined)?.username ?? null;
          yield* updateRuntime(projectId, { botUsername: username });
        } else {
          yield* updateRuntime(projectId, {
            lastError: me.description ?? "getMe failed — check the bot token.",
          });
          return;
        }
      }

      const offset = (yield* getRuntime(projectId)).offset;
      const response = yield* fetchJson(
        telegramApi(config.botToken, "getUpdates") +
          `?timeout=${POLL_TIMEOUT_SECONDS}&offset=${offset}&allowed_updates=%5B%22message%22%5D`,
      );
      if (response.ok !== true) {
        yield* updateRuntime(projectId, {
          lastError: response.description ?? "getUpdates failed.",
        });
        return;
      }
      yield* updateRuntime(projectId, { lastError: null });
      const updates = (response.result ?? []) as ReadonlyArray<TelegramUpdate>;
      for (const update of updates) {
        yield* updateRuntime(projectId, { offset: update.update_id + 1 });
        yield* handleUpdate(projectId, config, update).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("telegram update handling failed").pipe(
              Effect.annotateLogs({ projectId, cause }),
            ),
          ),
        );
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* updateRuntime(projectId, {
            lastError: cause instanceof Error ? cause.message : "Telegram polling failed.",
          });
          yield* Effect.logWarning("telegram poll cycle failed").pipe(
            Effect.annotateLogs({ projectId, cause }),
          );
        }),
      ),
    );

  const pollCycle = Effect.gen(function* () {
    const records = yield* connectorRepository.listByKind("telegram").pipe(
      Effect.orElseSucceed(() => []),
    );
    const enabled = records.flatMap((record) => {
      const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(record.config);
      return decoded._tag === "Success" && decoded.value.enabled
        ? [{ projectId: record.projectId, config: decoded.value }]
        : [];
    });
    if (enabled.length === 0) {
      yield* Effect.sleep(IDLE_RECHECK);
      return;
    }
    // Poll all enabled bots concurrently; each long-polls up to 10s.
    yield* Effect.forEach(
      enabled,
      ({ projectId, config }) => pollConnector(projectId, config),
      { concurrency: 4, discard: true },
    );
  });

  yield* Effect.forkScoped(Effect.forever(pollCycle));

  return {
    getRuntimeStatus: (projectId) =>
      getRuntime(projectId).pipe(
        Effect.map((runtime) => ({
          botUsername: runtime.botUsername,
          lastError: runtime.lastError,
        })),
      ),
  } satisfies ManagerTelegramServiceShape;
});

export const ManagerTelegramServiceLive = Layer.effect(
  ManagerTelegramService,
  makeTelegramConnector,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
