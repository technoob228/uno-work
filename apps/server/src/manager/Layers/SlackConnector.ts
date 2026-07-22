/**
 * SlackConnector - Slack ingress/egress for assistants, over Socket Mode.
 *
 * Where Telegram long-polls, Slack pushes: this connector keeps one persistent
 * Socket Mode connection per enabled `slack` connector row (reconciled against
 * the DB every few seconds, so saving settings takes effect without a restart)
 * and routes inbound messages from allowlisted channels/DMs into that
 * assistant's threads.
 *
 * Session model is thread-first (see {@link slackChatKey}): a DM is one session
 * per channel; an addressed channel message opens a session under its own
 * thread (the bot replies in that thread); replies inside a bot-owned thread
 * continue it. Addressing (when to react at all) is the same transport-agnostic
 * policy Telegram uses — a DM always answers, a channel needs an @mention, a
 * name, a live thread, or the opt-in smart classifier.
 *
 * The Slack SDK is imperative (an EventEmitter + a WebClient); events cross into
 * Effect via `runFork`, and the socket lifecycle lives in a plain map managed by
 * the reconcile loop.
 */
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import {
  CommandId,
  ManagerSlackConnectorConfig,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  slackChatKey,
  ThreadId,
  UNO_GATEWAY_BASE_URL,
  type ChatImageAttachment,
  type ModelSelection,
} from "@t3tools/contracts";
import { Context, Data, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorRepository } from "../../persistence/Services/ManagerConnectors.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { DEFAULT_ADDRESSING_CONFIG, decideAddressing } from "../addressing.ts";
import type { AddressingReason } from "../addressing.ts";
import {
  buildMediaFailureNote,
  buildMediaNote,
  isImageLikeMedia,
  sanitizeFileName,
  type TelegramMediaDescriptor,
} from "../telegramMedia.ts";
import {
  buildTranscriptMessageText,
  isTranscribableMedia,
  transcribeTelegramAudio,
} from "../telegramTranscription.ts";
import { classifyWake } from "../wakeClassifier.ts";
import { resolveTurnReply } from "./TelegramConnector.ts";

export interface ManagerSlackRuntimeStatus {
  readonly botUserId: string | null;
  readonly botUserName: string | null;
  readonly lastError: string | null;
}

export interface ManagerSlackServiceShape {
  readonly getRuntimeStatus: (projectId: ProjectId) => Effect.Effect<ManagerSlackRuntimeStatus>;
  /**
   * Proactively post text to a Slack channel/DM (reminders, notifications).
   * Resolves the bot token from the live connection. Never fails; a `false`
   * means delivery failed.
   */
  readonly sendText: (input: {
    readonly projectId: ProjectId;
    readonly channelId: string;
    readonly text: string;
    readonly threadTs?: string;
  }) => Effect.Effect<boolean>;
}

export class ManagerSlackService extends Context.Service<
  ManagerSlackService,
  ManagerSlackServiceShape
>()("t3/manager/Services/ManagerSlackService") {}

const RECONCILE_INTERVAL = Duration.seconds(5);
const REPLY_POLL_INTERVAL = Duration.seconds(2);
const REPLY_TIMEOUT = Duration.minutes(10);
const SLACK_MESSAGE_LIMIT = 3900;
// Post a "working on it" ack if the reply is not ready quickly, so channel
// users see the mention landed (thread creation + a model turn take a while).
const ACK_DELAY = Duration.seconds(10);
const ACK_TEXT = "⏳ On it — I'll post the result in this thread.";
// When a session opens mid-thread, this much backlog is handed to the
// assistant as context: the root message plus the most recent replies.
const BACKLOG_FETCH_LIMIT = 100;
const BACKLOG_MAX_MESSAGES = 25;
const BACKLOG_MESSAGE_CHAR_LIMIT = 1500;
const BACKLOG_TOTAL_CHAR_LIMIT = 6000;
// Dedup window: Slack delivers the same message as both `app_mention` and
// `message.channels`, and retries on missed acks; keyed by channel:ts.
const SEEN_TTL_MS = 5 * 60 * 1000;

class SlackConnectorError extends Data.TaggedError("SlackConnectorError")<{
  readonly message: string;
}> {}

/** A file attached to a Slack message (`file_share` subtype). */
interface SlackRawFile {
  readonly id?: string;
  readonly name?: string;
  readonly mimetype?: string;
  readonly size?: number;
  readonly url_private_download?: string;
}

/** The loosely-typed slice of a Slack event we read. */
interface SlackRawEvent {
  readonly type?: string;
  readonly channel?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly user?: string;
  readonly text?: string;
  readonly channel_type?: string;
  readonly subtype?: string;
  readonly bot_id?: string;
  readonly files?: ReadonlyArray<SlackRawFile>;
}

// Slack file downloads are authenticated with the bot token; cap what we pull.
const SLACK_FILE_DOWNLOAD_LIMIT_BYTES = 100 * 1024 * 1024;

/**
 * Standing instruction appended to every Slack-originated turn — same marker
 * the Telegram connector uses, so harness behavior carries over.
 */
const SLACK_SEND_FILE_HINT =
  "[slack: to attach a file to your Slack reply, put [[send-file: /absolute/path]] on its own line]";

/**
 * Map a Slack file onto the connector-neutral media descriptor so the shared
 * note/transcription helpers apply. Audio becomes "voice" (transcribable),
 * video "video", images "photo"-like via mime, the rest "document".
 */
function toMediaDescriptor(file: SlackRawFile): TelegramMediaDescriptor | null {
  if (file.url_private_download === undefined || file.id === undefined) {
    return null;
  }
  const mimeType = file.mimetype ?? null;
  const kind =
    mimeType !== null && mimeType.startsWith("audio/")
      ? ("voice" as const)
      : mimeType !== null && mimeType.startsWith("video/")
        ? ("video" as const)
        : ("document" as const);
  return {
    kind,
    fileId: file.id,
    fileName: sanitizeFileName(file.name ?? "", kind === "voice" ? "audio.m4a" : "file.bin"),
    mimeType,
    durationSec: null,
    sizeBytes: file.size ?? null,
  };
}

interface SlackRuntime {
  readonly appToken: string;
  readonly botToken: string;
  /** Full connector config as JSON — the reconcile loop restarts the
   * connection when ANY of it changes (allowlist, addressing, model), not
   * just the tokens, because the live event handler captures it by value. */
  readonly configJson: string;
  botUserId: string | null;
  botUserName: string | null;
  lastError: string | null;
  client: SocketModeClient | null;
  web: WebClient | null;
}

/**
 * Fetch the backlog of a Slack thread the bot was just called into: the root
 * message plus the most recent replies, minus the triggering message itself.
 * Uses the history scopes the app manifest already requests. Failures
 * degrade to "no context" — the mention is still answered.
 */
const fetchThreadBacklog = (input: {
  readonly web: WebClient;
  readonly channel: string;
  readonly threadTs: string;
  readonly excludeTs: string;
  readonly botUserId: string;
}): Effect.Effect<ReadonlyArray<string>> =>
  Effect.tryPromise({
    try: () =>
      input.web.conversations.replies({
        channel: input.channel,
        ts: input.threadTs,
        limit: BACKLOG_FETCH_LIMIT,
      }),
    catch: (cause) => new SlackConnectorError({ message: String(cause) }),
  }).pipe(
    Effect.map((result) => {
      const all = (result.messages ?? []) as ReadonlyArray<{
        readonly ts?: string;
        readonly user?: string;
        readonly bot_id?: string;
        readonly text?: string;
      }>;
      // conversations.replies returns oldest-first with the root message
      // first; keep the root and the most recent replies.
      const root = all.length > 0 ? [all[0]] : [];
      const replies = all.slice(1).slice(-(BACKLOG_MAX_MESSAGES - root.length));
      const lines: Array<string> = [];
      let used = 0;
      for (const message of [...root, ...replies]) {
        if (message === undefined) continue;
        if (message.ts === undefined || message.ts === input.excludeTs) continue;
        const text = (message.text ?? "").trim();
        if (text.length === 0) continue;
        const author =
          message.user === input.botUserId
            ? "you (the assistant)"
            : message.user !== undefined
              ? `<@${message.user}>`
              : "another bot";
        const line = `${author}: ${text.slice(0, BACKLOG_MESSAGE_CHAR_LIMIT)}`;
        if (used + line.length > BACKLOG_TOTAL_CHAR_LIMIT) break;
        lines.push(line);
        used += line.length;
      }
      return lines;
    }),
    Effect.catch((cause) =>
      Effect.logWarning("slack thread backlog fetch failed").pipe(
        Effect.annotateLogs({ channel: input.channel, cause: String(cause) }),
        Effect.andThen(Effect.succeed([] as ReadonlyArray<string>)),
      ),
    ),
  );

const makeSlackConnector = Effect.gen(function* () {
  const connectorRepository = yield* ManagerConnectorRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;

  // Non-image incoming files land here; the harness reads them by absolute
  // path (Slack threads always run in full-access mode).
  const slackFilesDir = nodePath.join(serverConfig.stateDir, "slack-files");

  // Run per-event Effects from the imperative socket callbacks.
  const runtimeContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(runtimeContext);

  // Live connections, managed by the reconcile loop; read by getRuntimeStatus.
  const runtimes = new Map<ProjectId, SlackRuntime>();
  const seen = new Map<string, number>();

  const hotWindowRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const markHotWindow = (key: string) =>
    Ref.update(hotWindowRef, (map) => new Map(map).set(key, Date.now()));
  const isWithinHotWindow = (key: string, windowSec: number) =>
    windowSec <= 0
      ? Effect.succeed(false)
      : Ref.get(hotWindowRef).pipe(
          Effect.map((map) => {
            const last = map.get(key);
            return last !== undefined && Date.now() - last <= windowSec * 1000;
          }),
        );

  const sameHarnessAndModel = (a: ModelSelection, b: ModelSelection): boolean =>
    a.instanceId === b.instanceId && a.model === b.model;

  const getUnoApiKey = serverSettingsService.getSettings.pipe(
    Effect.map((settings) => settings.uno.apiKey?.trim() ?? ""),
    Effect.orElseSucceed(() => ""),
  );

  const postMessage = (
    web: WebClient,
    channel: string,
    text: string,
    threadTs: string | undefined,
  ) =>
    Effect.tryPromise({
      try: () =>
        web.chat.postMessage({
          channel,
          text: text.slice(0, SLACK_MESSAGE_LIMIT),
          ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
        }),
      catch: (cause) => new SlackConnectorError({ message: String(cause) }),
    });

  // Download a Slack file (authenticated with the bot token) into raw bytes.
  const downloadSlackFile = (botToken: string, url: string) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${botToken}` },
        });
        if (!response.ok) {
          throw new Error(`file download failed with status ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      catch: (cause) =>
        new SlackConnectorError({ message: `Slack file download failed: ${String(cause)}` }),
    });

  // Mirror of the Telegram media pipeline: images become vision attachments,
  // audio is transcribed through the gateway, everything else lands on disk
  // and is described to the harness by absolute path. Failures degrade to
  // notes so the turn still runs.
  const ingestSlackFiles = (input: {
    readonly botToken: string;
    readonly threadId: ThreadId;
    readonly channel: string;
    readonly files: ReadonlyArray<SlackRawFile>;
  }) =>
    Effect.gen(function* () {
      const attachments: Array<ChatImageAttachment> = [];
      const notes: Array<string> = [];
      for (const file of input.files) {
        const descriptor = toMediaDescriptor(file);
        if (descriptor === null) continue;
        if (
          descriptor.sizeBytes !== null &&
          descriptor.sizeBytes > SLACK_FILE_DOWNLOAD_LIMIT_BYTES
        ) {
          notes.push(buildMediaFailureNote(descriptor, "the file exceeds the 100 MB download cap"));
          continue;
        }
        const downloaded = yield* downloadSlackFile(
          input.botToken,
          file.url_private_download ?? "",
        ).pipe(
          Effect.map((bytes) => ({ ok: true as const, bytes })),
          Effect.catch((cause) => Effect.succeed({ ok: false as const, reason: cause.message })),
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
                catch: (cause) => new SlackConnectorError({ message: String(cause) }),
              }).pipe(
                Effect.map(() => true),
                Effect.catch(() => Effect.succeed(false)),
              );
              if (stored) {
                attachments.push(attachment);
                continue;
              }
            }
          }
        }

        const directory = nodePath.join(slackFilesDir, input.channel);
        const savedPath = nodePath.join(
          directory,
          `${crypto.randomUUID().slice(0, 8)}-${descriptor.fileName}`,
        );
        const saved = yield* Effect.tryPromise({
          try: async () => {
            await fsPromises.mkdir(directory, { recursive: true });
            await fsPromises.writeFile(savedPath, bytes);
          },
          catch: (cause) => new SlackConnectorError({ message: String(cause) }),
        }).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!saved) {
          notes.push(buildMediaFailureNote(descriptor, "failed to save the file on the server"));
          continue;
        }

        if (isTranscribableMedia(descriptor)) {
          const unoApiKey = yield* getUnoApiKey;
          if (unoApiKey.length > 0) {
            const transcript = yield* transcribeTelegramAudio({
              baseUrl: UNO_GATEWAY_BASE_URL,
              apiKey: unoApiKey,
              bytes,
              fileName: descriptor.fileName,
              mimeType: descriptor.mimeType,
            }).pipe(Effect.catch(() => Effect.succeed(null)));
            if (transcript !== null) {
              notes.push(buildTranscriptMessageText({ descriptor, transcript, savedPath }));
              continue;
            }
          }
        }

        notes.push(buildMediaNote(descriptor, savedPath));
      }
      return { attachments, notes };
    });

  // Upload a `[[send-file: …]]` artifact back into the conversation. Failures
  // are reported into the chat so the user isn't left waiting.
  const sendSlackFile = (input: {
    readonly web: WebClient;
    readonly channel: string;
    readonly threadTs: string | undefined;
    readonly filePath: string;
  }) =>
    Effect.gen(function* () {
      const failure = yield* Effect.tryPromise({
        try: async () => {
          const stat = await fsPromises.stat(input.filePath);
          if (!stat.isFile()) {
            throw new Error("not a regular file");
          }
          const fileName = nodePath.basename(input.filePath);
          if (input.threadTs !== undefined) {
            await input.web.files.uploadV2({
              channel_id: input.channel,
              thread_ts: input.threadTs,
              file: input.filePath,
              filename: fileName,
            });
          } else {
            await input.web.files.uploadV2({
              channel_id: input.channel,
              file: input.filePath,
              filename: fileName,
            });
          }
        },
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.map(() => null),
        Effect.catch((reason) => Effect.succeed(reason)),
      );
      if (failure !== null) {
        yield* Effect.logWarning("slack file upload failed").pipe(
          Effect.annotateLogs({ channel: input.channel, filePath: input.filePath, failure }),
        );
        yield* postMessage(
          input.web,
          input.channel,
          `Could not send ${input.filePath}: ${failure}`,
          input.threadTs,
        );
      }
    });

  const ensureThreadForChat = (input: {
    readonly projectId: ProjectId;
    readonly chatKey: string;
    readonly title: string;
    readonly config: ManagerSlackConnectorConfig;
  }) =>
    Effect.gen(function* () {
      const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId);
      const modelSelection =
        input.config.defaultModelSelection ??
        (Option.isSome(project) ? project.value.defaultModelSelection : null);

      const existing = yield* connectorRepository.getThreadForChat({
        projectId: input.projectId,
        kind: "slack",
        chatId: input.chatKey,
      });
      if (Option.isSome(existing)) {
        const shell = yield* projectionSnapshotQuery.getThreadShellById(existing.value);
        if (Option.isSome(shell) && shell.value.archivedAt === null) {
          if (
            modelSelection === null ||
            sameHarnessAndModel(shell.value.modelSelection, modelSelection)
          ) {
            return existing.value;
          }
        }
      }
      if (modelSelection === null) {
        return yield* Effect.fail(new Error("Assistant project has no model configured."));
      }
      const threadId = ThreadId.make(crypto.randomUUID());
      const createdAt = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`slack:${crypto.randomUUID()}`),
        threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* connectorRepository.setThreadForChat({
        projectId: input.projectId,
        kind: "slack",
        chatId: input.chatKey,
        threadId,
        createdAt,
      });
      return threadId;
    });

  const watchAndReply = (input: {
    readonly web: WebClient;
    readonly channel: string;
    readonly threadTs: string | undefined;
    readonly threadId: ThreadId;
    readonly requestedAtIso: string;
    readonly hotKey: string;
  }) =>
    Effect.gen(function* () {
      const deadline = Date.now() + Duration.toMillis(REPLY_TIMEOUT);
      const ackAt = Date.now() + Duration.toMillis(ACK_DELAY);
      let acked = false;
      const maybeAck = Effect.gen(function* () {
        if (!acked && Date.now() >= ackAt) {
          acked = true;
          yield* postMessage(input.web, input.channel, ACK_TEXT, input.threadTs);
        }
      });
      while (Date.now() < deadline) {
        yield* Effect.sleep(REPLY_POLL_INTERVAL);
        const detail = yield* projectionSnapshotQuery.getThreadDetailById(input.threadId);
        if (Option.isNone(detail)) {
          yield* maybeAck;
          continue;
        }
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
        if (reply === null) {
          yield* maybeAck;
          continue;
        }
        if (reply.text.trim().length > 0) {
          yield* postMessage(input.web, input.channel, reply.text, input.threadTs);
        } else if (reply.files.length === 0) {
          yield* postMessage(input.web, input.channel, "Done.", input.threadTs);
        }
        for (const filePath of reply.files) {
          yield* sendSlackFile({
            web: input.web,
            channel: input.channel,
            threadTs: input.threadTs,
            filePath,
          });
        }
        yield* markHotWindow(input.hotKey);
        return;
      }
      yield* postMessage(
        input.web,
        input.channel,
        "The assistant is still working on it; check the app for progress.",
        input.threadTs,
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("slack reply watcher failed").pipe(
          Effect.annotateLogs({ channel: input.channel, cause: String(cause) }),
        ),
      ),
    );

  const handleMessage = (
    projectId: ProjectId,
    config: ManagerSlackConnectorConfig,
    web: WebClient,
    botUserId: string,
    event: SlackRawEvent,
  ) =>
    Effect.gen(function* () {
      const channel = event.channel;
      const ts = event.ts;
      if (channel === undefined || ts === undefined) return;
      // Skip edits, joins, bot_message — only plain new messages and file shares.
      if (event.subtype !== undefined && event.subtype !== "file_share") return;
      const rawText = typeof event.text === "string" ? event.text : "";
      const files = event.files ?? [];
      if (rawText.trim().length === 0 && files.length === 0) return;
      if (!config.allowedChannelIds.includes(channel)) {
        yield* Effect.logDebug("slack message from non-allowlisted channel ignored").pipe(
          Effect.annotateLogs({ projectId, channel }),
        );
        return;
      }
      const senderIsBot = event.bot_id !== undefined || event.user === botUserId;
      const isDM = event.channel_type === "im";
      const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
      const chatKey = slackChatKey(channel, isDM ? null : (threadTs ?? ts));
      const addressing = config.addressing ?? DEFAULT_ADDRESSING_CONFIG;
      const mentionToken = `<@${botUserId}>`;
      const cleanedText = rawText.split(mentionToken).join(" ").replace(/\s+/g, " ").trim();

      const existing = yield* connectorRepository
        .getThreadForChat({ projectId, kind: "slack", chatId: chatKey })
        .pipe(Effect.orElseSucceed(() => Option.none<ThreadId>()));
      const hotKey = `${projectId}:${chatKey}`;
      const withinHotWindow = yield* isWithinHotWindow(hotKey, addressing.hotWindowSec);

      const normalized = {
        isDirectMessage: isDM,
        // A live bot-owned thread — continuing the conversation counts as addressing.
        isReplyToBot: Option.isSome(existing) && !isDM,
        explicitMention: event.type === "app_mention" || rawText.includes(mentionToken),
        senderIsBot,
        text: cleanedText,
      };
      let decision = decideAddressing(normalized, addressing, { withinHotWindow });

      if (!decision.addressed && decision.needsSmartCheck) {
        const unoApiKey = yield* getUnoApiKey;
        if (unoApiKey.length > 0) {
          const addressed = yield* classifyWake({
            baseUrl: UNO_GATEWAY_BASE_URL,
            apiKey: unoApiKey,
            names: addressing.names,
            text: cleanedText,
          }).pipe(Effect.catch(() => Effect.succeed(false)));
          if (addressed) {
            decision = { addressed: true, reason: "smart" satisfies AddressingReason };
          }
        }
      }

      if (!decision.addressed) {
        yield* Effect.logDebug("slack message not addressed to the bot; ignored").pipe(
          Effect.annotateLogs({ projectId, channel }),
        );
        return;
      }

      const title = isDM ? `Slack DM ${channel}` : `Slack: ${channel}`;
      const threadId = yield* ensureThreadForChat({ projectId, chatKey, title, config });
      // First contact inside an existing Slack thread: the session has no
      // history yet, but the humans in the thread do — hand it over so the
      // assistant is not blind to the message it was called under.
      const backlog =
        Option.isNone(existing) && !isDM && threadTs !== null
          ? yield* fetchThreadBacklog({ web, channel, threadTs, excludeTs: ts, botUserId })
          : [];
      const ingested =
        files.length > 0
          ? yield* ingestSlackFiles({ botToken: config.botToken, threadId, channel, files })
          : { attachments: [], notes: [] };
      const bodyParts = [cleanedText, ...ingested.notes].filter((part) => part.length > 0);
      if (bodyParts.length === 0) {
        bodyParts.push("[The user sent the attached image(s) without a caption.]");
      }
      const contextBlock =
        backlog.length > 0
          ? [
              "[Slack thread context — earlier messages in this thread, oldest first:]",
              ...backlog,
            ].join("\n")
          : null;
      const body = [
        ...(contextBlock !== null ? [contextBlock] : []),
        ...bodyParts,
        SLACK_SEND_FILE_HINT,
      ].join("\n\n");
      const requestedAtIso = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`slack:${crypto.randomUUID()}`),
        threadId,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text: body,
          attachments: ingested.attachments,
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: requestedAtIso,
      });
      // DMs reply flat; channel replies land in the message's thread.
      const replyThreadTs = isDM ? undefined : (threadTs ?? ts);
      yield* watchAndReply({
        web,
        channel,
        threadTs: replyThreadTs,
        threadId,
        requestedAtIso,
        hotKey,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("slack message handling failed").pipe(
          Effect.annotateLogs({ projectId, cause: String(cause) }),
        ),
      ),
    );

  // Dedup + hand an inbound event to the Effect world. Synchronous up to the
  // fork so app_mention/message duplicates for the same ts never both run.
  const dispatchRawEvent = (
    projectId: ProjectId,
    config: ManagerSlackConnectorConfig,
    web: WebClient,
    botUserId: string,
    event: SlackRawEvent | undefined,
  ): void => {
    if (event?.channel === undefined || event.ts === undefined) return;
    const key = `${event.channel}:${event.ts}`;
    const now = Date.now();
    if (seen.has(key)) return;
    seen.set(key, now);
    if (seen.size > 500) {
      for (const [k, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(k);
    }
    runFork(handleMessage(projectId, config, web, botUserId, event));
  };

  const stopConnection = (projectId: ProjectId) => {
    const runtime = runtimes.get(projectId);
    if (runtime?.client) {
      void runtime.client.disconnect().catch(() => undefined);
    }
    runtimes.delete(projectId);
  };

  const startConnection = (projectId: ProjectId, config: ManagerSlackConnectorConfig) =>
    Effect.gen(function* () {
      const web = new WebClient(config.botToken);
      const auth = yield* Effect.tryPromise({
        try: () => web.auth.test(),
        catch: (cause) => new SlackConnectorError({ message: String(cause) }),
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      if (auth === null || typeof auth.user_id !== "string") {
        runtimes.set(projectId, {
          appToken: config.appToken,
          botToken: config.botToken,
          configJson: JSON.stringify(config),
          botUserId: null,
          botUserName: null,
          lastError: "auth.test failed — check the bot token.",
          client: null,
          web: null,
        });
        return;
      }
      const botUserId = auth.user_id;
      const botUserName = typeof auth.user === "string" ? auth.user : null;
      const client = new SocketModeClient({ appToken: config.appToken });
      const handler = (payload: { readonly event?: SlackRawEvent }): void =>
        dispatchRawEvent(projectId, config, web, botUserId, payload?.event);
      client.on("message", handler);
      client.on("app_mention", handler);

      const started = yield* Effect.tryPromise({
        try: () => client.start(),
        catch: (cause) => new SlackConnectorError({ message: String(cause) }),
      }).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
      runtimes.set(projectId, {
        appToken: config.appToken,
        botToken: config.botToken,
        configJson: JSON.stringify(config),
        botUserId,
        botUserName,
        lastError: started ? null : "Socket Mode connection failed — check the app token.",
        client: started ? client : null,
        web,
      });
    });

  const reconcile = Effect.gen(function* () {
    const records = yield* connectorRepository
      .listByKind("slack")
      .pipe(Effect.orElseSucceed(() => []));
    const enabled = new Map<ProjectId, ManagerSlackConnectorConfig>();
    for (const record of records) {
      const decoded = Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(record.config);
      if (decoded._tag === "Success" && decoded.value.enabled) {
        enabled.set(record.projectId, decoded.value);
      }
    }
    // Tear down disabled/removed connectors and ones whose tokens changed.
    for (const [projectId, runtime] of [...runtimes]) {
      const config = enabled.get(projectId);
      if (config === undefined || JSON.stringify(config) !== runtime.configJson) {
        stopConnection(projectId);
      }
    }
    // (Re)start connectors without a live client (new, or previously failed).
    for (const [projectId, config] of enabled) {
      if (runtimes.get(projectId)?.client == null) {
        yield* startConnection(projectId, config).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("slack connection start failed").pipe(
              Effect.annotateLogs({ projectId, cause: String(cause) }),
            ),
          ),
        );
      }
    }
  });

  yield* Effect.forkScoped(
    Effect.forever(reconcile.pipe(Effect.andThen(Effect.sleep(RECONCILE_INTERVAL)))),
  );

  const sendText: ManagerSlackServiceShape["sendText"] = (input) =>
    Effect.gen(function* () {
      const runtime = runtimes.get(input.projectId);
      if (runtime?.web == null) {
        yield* Effect.logWarning("slack push skipped: no live connection").pipe(
          Effect.annotateLogs({ projectId: input.projectId, channel: input.channelId }),
        );
        return false;
      }
      return yield* postMessage(runtime.web, input.channelId, input.text, input.threadTs).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
    });

  return {
    getRuntimeStatus: (projectId) =>
      Effect.sync(() => {
        const runtime = runtimes.get(projectId);
        return {
          botUserId: runtime?.botUserId ?? null,
          botUserName: runtime?.botUserName ?? null,
          lastError: runtime?.lastError ?? null,
        };
      }),
    sendText,
  } satisfies ManagerSlackServiceShape;
});

export const ManagerSlackServiceLive = Layer.effect(ManagerSlackService, makeSlackConnector).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
