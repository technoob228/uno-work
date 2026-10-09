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
 *
 * Relay mode ("Add to Slack" with Uno's app, onboarding v3): a row whose bot
 * token is `unorelay:<slr_…>` never opens Socket Mode. Its WebClient talks to
 * the console's Web-API relay, and its events are long-polled from the
 * console queue (`slackRelayEvents.ts`, durable cursor) and fed into the very
 * same handler. Private files and uploads go through the relay too
 * (`channelRelay.ts` builds every such URL).
 */
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import {
  ASSISTANT_PROJECT_ID,
  CommandId,
  ManagerSlackConnectorConfig,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  slackChatKey,
  ThreadId,
  UNO_GATEWAY_BASE_URL,
  type ChatImageAttachment,
  type ModelSelection,
} from "@t3tools/contracts";
import { Context, Data, Duration, Effect, Fiber, Layer, Option, Ref, Schema } from "effect";
import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { slackCommandOrigin } from "../../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorRepository } from "../../persistence/Services/ManagerConnectors.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ManagerConnectorPendingReplyRepositoryLive } from "../../persistence/Layers/ManagerConnectorPendingReplies.ts";
import type { ConnectorPendingReply } from "../../persistence/Services/ManagerConnectorPendingReplies.ts";
import { makeConnectorReplies, readMeta, type SendOutcome } from "../connectorReplies.ts";
import { detectReplyLanguage } from "../connectorReplyText.ts";
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
import { currentAssistantModelSelection } from "../assistantEngineSelection.ts";
import { sameAssistantEngine } from "../connectorBindings.ts";
import {
  classifySlackSender,
  type ConnectorSenderRole,
  withOwnerUserId,
} from "../connectorSenders.ts";
import {
  parseRelayCredential,
  parseRouteCredential,
  redactConnectorSecrets,
  slackFileRequest,
  slackRelayApiBase,
  slackUploadTarget,
} from "../channelRelay.ts";
import { runSlackRelayEventLoop, type SlackEventsApiPayload } from "../slackRelayEvents.ts";
import {
  assistantForSlackChannel,
  defaultSlackAssistant,
  isCustomizeRefused,
  matchAssistantName,
  slackIconEmoji,
  slackNowAnswers,
  slackWhoIsThisFor,
  type SlackAssistantChoice,
} from "../slackAssistants.ts";
import { bindingOnConnector } from "../connectorBindings.ts";
import { ManagerConnectorBindingRepository } from "../../persistence/Services/ManagerConnectorBindings.ts";
import { readProfile } from "../../assistants/localAssistantStore.ts";

export interface ManagerSlackRuntimeStatus {
  readonly botUserId: string | null;
  readonly botUserName: string | null;
  readonly lastError: string | null;
  /** A live event source: the Socket Mode socket, or a relay poller whose last poll succeeded. */
  readonly connected: boolean;
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
    /** Write as this assistant (name + emoji) when several share Uno's app. */
    readonly asAssistant?: ProjectId;
  }) => Effect.Effect<boolean>;
  /**
   * Channels of the workspace, through the bot this assistant talks through
   * (its own, or the holder's for a routed row). Null without a live bot.
   */
  readonly listChannels: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly isPrivate: boolean;
    readonly isMember: boolean;
  }> | null>;
  /** Joins a public channel so the app hears it (best effort). */
  readonly joinChannel: (projectId: ProjectId, channelId: string) => Effect.Effect<boolean>;
}

export class ManagerSlackService extends Context.Service<
  ManagerSlackService,
  ManagerSlackServiceShape
>()("t3/manager/Services/ManagerSlackService") {}

const RECONCILE_INTERVAL = Duration.seconds(5);
const SLACK_MESSAGE_LIMIT = 3900;
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
  /** Relay mode: stops the event poller. Null for Socket Mode / a failed start. */
  stopRelay: (() => void) | null;
  /** Relay mode: whether the last poll reached the console. */
  relayConnected: boolean;
  /**
   * The bot may write under another name (`chat:write.customize`); null when
   * Slack didn't say (an older relay drops the scopes header).
   */
  canCustomize?: boolean | null;
}

/** Who a message is written as: an assistant's name and Slack emoji. */
interface SlackIdentity {
  readonly username: string;
  readonly iconEmoji: string;
  /** Prefix the text with the name: the custom name may not show. */
  readonly prefix: boolean;
}

/** Whether the runtime has a live (or retrying, for the relay) event source. */
const hasEventSource = (runtime: SlackRuntime | undefined): boolean =>
  runtime !== undefined && (runtime.client !== null || runtime.stopRelay !== null);

/**
 * A WebClient for a connector credential: Slack itself with the bot token,
 * or — relay mode — the console's Web-API relay, which adds the
 * installation's token on its side (so none is sent from here).
 */
export function makeSlackWebClient(botToken: string): WebClient {
  const relay = parseRelayCredential(botToken);
  return relay === null
    ? new WebClient(botToken)
    : new WebClient(undefined, { slackApiUrl: slackRelayApiBase(relay) });
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

/**
 * Relay-mode upload: the same three steps `files.uploadV2` performs, with the
 * byte transfer routed through the console (`/upload?url=`) — the WebClient's
 * own upload goes straight to `upload_url`, which only Slack-token holders
 * may do.
 */
async function uploadSlackFileViaRelay(input: {
  readonly web: WebClient;
  readonly botToken: string;
  readonly channel: string;
  readonly threadTs: string | undefined;
  readonly filePath: string;
  readonly fileName: string;
  readonly size: number;
}): Promise<void> {
  const target = await input.web.files.getUploadURLExternal({
    filename: input.fileName,
    length: input.size,
  });
  if (typeof target.upload_url !== "string" || typeof target.file_id !== "string") {
    throw new Error(target.error ?? "files.getUploadURLExternal returned no upload URL");
  }
  const bytes = await fsPromises.readFile(input.filePath);
  const response = await fetch(slackUploadTarget(input.botToken, target.upload_url), {
    method: "POST",
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    throw new Error(`upload failed with status ${response.status}`);
  }
  await input.web.files.completeUploadExternal({
    files: [{ id: target.file_id, title: input.fileName }],
    channel_id: input.channel,
    ...(input.threadTs !== undefined ? { thread_ts: input.threadTs } : {}),
  });
}

const replyRowKey = (row: ConnectorPendingReply) => `${row.connectorProjectId}:${row.replyKey}`;

/** Slack's verdict on a failed call: a refusal of the chat itself will not pass. */
const slackSendOutcome = (cause: unknown): SendOutcome =>
  /channel_not_found|not_in_channel|is_archived|account_inactive|invalid_auth|token_revoked|msg_too_long/.test(
    String(cause),
  )
    ? "gone"
    : "retry";

const makeSlackConnector = Effect.gen(function* () {
  const connectorRepository = yield* ManagerConnectorRepository;
  const bindingRepository = yield* ManagerConnectorBindingRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
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

  const getUnoApiKey = serverSettingsService.getSettings.pipe(
    Effect.map((settings) => settings.uno.apiKey?.trim() ?? ""),
    Effect.orElseSucceed(() => ""),
  );

  const postMessage = (
    web: WebClient,
    channel: string,
    text: string,
    threadTs: string | undefined,
    identity: SlackIdentity | null = null,
    /** In a thread, also show the message in the channel / DM itself. */
    broadcast = false,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const base = {
          channel,
          text: text.slice(0, SLACK_MESSAGE_LIMIT),
          ...(threadTs === undefined
            ? {}
            : broadcast
              ? { thread_ts: threadTs, reply_broadcast: true as const }
              : { thread_ts: threadTs }),
        };
        if (identity === null) return web.chat.postMessage(base);
        const named = identity.prefix
          ? `*${identity.username}:* ${base.text}`.slice(0, SLACK_MESSAGE_LIMIT)
          : base.text;
        try {
          return await web.chat.postMessage({
            ...base,
            text: named,
            username: identity.username,
            icon_emoji: identity.iconEmoji,
          });
        } catch (cause) {
          // A workspace that added the app before chat:write.customize.
          if (!isCustomizeRefused(cause)) throw cause;
          return web.chat.postMessage({
            ...base,
            text: `*${identity.username}:* ${base.text}`.slice(0, SLACK_MESSAGE_LIMIT),
          });
        }
      },
      catch: (cause) => new SlackConnectorError({ message: String(cause) }),
    });

  // ── Several assistants through one Uno app (see slackAssistants.ts) ──

  const decodeSlackRow = (config: unknown): ManagerSlackConnectorConfig | null => {
    const decoded = Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(config);
    return decoded._tag === "Success" ? decoded.value : null;
  };

  const slackRows = connectorRepository.listByKind("slack").pipe(
    Effect.map((records) =>
      records.flatMap((record) => {
        const config = decodeSlackRow(record.config);
        return config === null ? [] : [{ projectId: record.projectId, config }];
      }),
    ),
    Effect.orElseSucceed(
      (): ReadonlyArray<{ projectId: ProjectId; config: ManagerSlackConnectorConfig }> => [],
    ),
  );

  const routedSlackRowsOf = (holder: ProjectId) =>
    slackRows.pipe(
      Effect.map((rows) =>
        rows.filter((row) => parseRouteCredential(row.config.botToken) === holder),
      ),
    );

  /** The assistant whose live connection carries this one (itself, or its holder). */
  const holderOf = (projectId: ProjectId) =>
    connectorRepository.get({ projectId, kind: "slack" }).pipe(
      Effect.map((row) => {
        const config = Option.isSome(row) ? decodeSlackRow(row.value.config) : null;
        const holder = config === null ? null : parseRouteCredential(config.botToken);
        return holder === null ? projectId : ProjectId.make(holder);
      }),
      Effect.orElseSucceed(() => projectId),
    );

  const assistantTitle = (projectId: ProjectId) =>
    projectionSnapshotQuery.getProjectShellById(projectId).pipe(
      Effect.map((project) => (Option.isSome(project) ? project.value : null)),
      Effect.orElseSucceed(() => null),
    );

  /** Name + emoji of an assistant, for a computer where several share one app. */
  const identityOf = (projectId: ProjectId, runtime: SlackRuntime | undefined) =>
    Effect.gen(function* () {
      const project = yield* assistantTitle(projectId);
      const profile =
        project === null ? null : yield* Effect.promise(() => readProfile(project.workspaceRoot));
      const title = project?.title ?? "Assistant";
      return {
        username: projectId === ASSISTANT_PROJECT_ID && title === "Assistant" ? "Uno" : title,
        iconEmoji: slackIconEmoji(profile?.emoji ?? null),
        prefix: runtime?.canCustomize !== true,
      } satisfies SlackIdentity;
    });

  const choicesOf = (holder: ProjectId, routed: ReadonlyArray<{ readonly projectId: ProjectId }>) =>
    Effect.forEach([holder, ...routed.map((row) => row.projectId)], (projectId) =>
      identityOf(projectId, undefined).pipe(
        Effect.map((identity): SlackAssistantChoice => ({ projectId, title: identity.username })),
      ),
    );

  // A DM's first message while it waits for "who is this for?" (in memory:
  // a restart just means the question is asked again).
  const pendingDmRef = yield* Ref.make<
    ReadonlyMap<string, { readonly event: SlackRawEvent; readonly at: number }>
  >(new Map());
  const PENDING_DM_MS = 10 * 60_000;

  // Download a Slack file (authenticated with the bot token) into raw bytes.
  const downloadSlackFile = (botToken: string, url: string) =>
    Effect.tryPromise({
      try: async () => {
        const request = slackFileRequest(botToken, url);
        const response = await fetch(request.url, { headers: request.headers });
        if (!response.ok) {
          throw new Error(`file download failed with status ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
      catch: (cause) =>
        new SlackConnectorError({
          message: `Slack file download failed: ${redactConnectorSecrets(String(cause))}`,
        }),
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
    readonly botToken: string;
    readonly channel: string;
    readonly threadTs: string | undefined;
    readonly filePath: string;
    readonly identity?: SlackIdentity | null;
  }) =>
    Effect.gen(function* () {
      const failure = yield* Effect.tryPromise({
        try: async () => {
          const stat = await fsPromises.stat(input.filePath);
          if (!stat.isFile()) {
            throw new Error("not a regular file");
          }
          const fileName = nodePath.basename(input.filePath);
          if (parseRelayCredential(input.botToken) !== null) {
            await uploadSlackFileViaRelay({
              web: input.web,
              botToken: input.botToken,
              channel: input.channel,
              threadTs: input.threadTs,
              filePath: input.filePath,
              fileName,
              size: stat.size,
            });
          } else if (input.threadTs !== undefined) {
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
          input.identity ?? null,
        );
      }
    });

  const ensureThreadForChat = (input: {
    readonly projectId: ProjectId;
    readonly chatKey: string;
    readonly title: string;
    readonly config: ManagerSlackConnectorConfig;
    /** Owner: full access (the assistant's own chats). Members: approval-required. */
    readonly runtimeMode: "full-access" | "approval-required";
  }) =>
    Effect.gen(function* () {
      // The assistant's Slack chats run on the Uno chat's engine (Hermes +
      // its provider / model, 0.0.84); a provider switch starts a fresh thread.
      const modelSelection: ModelSelection | null =
        yield* currentAssistantModelSelection(projectionSnapshotQuery);

      const existing = yield* connectorRepository.getThreadForChat({
        projectId: input.projectId,
        kind: "slack",
        chatId: input.chatKey,
      });
      if (Option.isSome(existing)) {
        const shell = yield* projectionSnapshotQuery.getThreadShellById(existing.value);
        if (
          Option.isSome(shell) &&
          shell.value.archivedAt === null &&
          shell.value.runtimeMode === input.runtimeMode
        ) {
          if (
            modelSelection === null ||
            sameAssistantEngine(shell.value.modelSelection, modelSelection)
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
      yield* orchestrationEngine.dispatch(
        {
          type: "thread.create",
          commandId: CommandId.make(`slack:${crypto.randomUUID()}`),
          threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        },
        { origin: slackCommandOrigin(input.chatKey) },
      );
      yield* connectorRepository.setThreadForChat({
        projectId: input.projectId,
        kind: "slack",
        chatId: input.chatKey,
        threadId,
        createdAt,
      });
      return threadId;
    });

  // A DM belongs to exactly one person: whoever writes in an allowlisted DM
  // is an owner, and may then drive the assistant from allowlisted channels.
  // Re-reads the stored row so a concurrent settings save is not lost.
  const rememberSlackOwner = (projectId: ProjectId, userId: string) =>
    Effect.gen(function* () {
      const stored = yield* connectorRepository.get({ projectId, kind: "slack" });
      if (Option.isNone(stored)) return;
      const decoded = Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(stored.value.config);
      if (decoded._tag !== "Success") return;
      const current = decoded.value;
      const ownerUserIds = withOwnerUserId(current.ownerUserIds, userId);
      if (ownerUserIds === current.ownerUserIds) return;
      yield* connectorRepository.upsert({
        projectId,
        kind: "slack",
        config: { ...current, ownerUserIds },
        updatedAt: new Date().toISOString(),
      });
      yield* Effect.logInfo("slack owner recorded from DM").pipe(
        Effect.annotateLogs({ projectId }),
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("slack owner could not be recorded").pipe(
          Effect.annotateLogs({ projectId, cause: String(cause) }),
        ),
      ),
    );

  // Slack has no "typing…" for apps: an ⏳ reaction on the person's message
  // says it landed and is being worked on (removed with the answer). A
  // workspace whose app may not react hears one short line instead.
  const reactedRef = yield* Ref.make<ReadonlySet<string>>(new Set());
  const WORKING_REACTION = "hourglass_flowing_sand";
  const identityForRow = (row: ConnectorPendingReply, runtime: SlackRuntime | undefined) => {
    const identityProjectId = readMeta(row).identityProjectId;
    return typeof identityProjectId === "string"
      ? identityOf(ProjectId.make(identityProjectId), runtime)
      : Effect.succeed(null);
  };

  // Answers to chat messages: on disk, bound to each message's own turn,
  // no deadline (see `connectorReplies.ts`).
  const replies = yield* makeConnectorReplies({
    kind: "slack",
    limit: SLACK_MESSAGE_LIMIT,
    logPrefix: "slack",
    typing: (row) =>
      Effect.gen(function* () {
        const key = replyRowKey(row);
        if ((yield* Ref.get(reactedRef)).has(key) || row.replyTo === null) return;
        const runtime = runtimes.get(row.connectorProjectId);
        const web = runtime?.web ?? null;
        if (web === null) return;
        yield* Ref.update(reactedRef, (set) => new Set(set).add(key));
        const replyTo = row.replyTo;
        const reacted = yield* Effect.tryPromise(() =>
          web.reactions.add({ channel: row.chatId, timestamp: replyTo, name: WORKING_REACTION }),
        ).pipe(
          Effect.as(true),
          Effect.catch((cause) => Effect.succeed(/already_reacted/.test(String(cause)))),
        );
        if (!reacted) {
          const identity = yield* identityForRow(row, runtime);
          yield* postMessage(
            web,
            row.chatId,
            row.language === "ru" ? "⏳ Работаю над этим…" : "⏳ On it…",
            row.replyThread ?? undefined,
            identity,
          ).pipe(Effect.ignore);
        }
      }),
    sendText: (row, text, { newerInChat }) =>
      Effect.gen(function* () {
        const runtime = runtimes.get(row.connectorProjectId);
        const web = runtime?.web ?? null;
        if (web === null) return "retry";
        const identity = yield* identityForRow(row, runtime);
        // A flat DM where the person wrote more since: the answer goes under
        // its own message, and still shows in the DM (reply_broadcast).
        const underOwnMessage = row.replyThread === null && newerInChat && row.replyTo !== null;
        return yield* postMessage(
          web,
          row.chatId,
          text,
          underOwnMessage ? (row.replyTo ?? undefined) : (row.replyThread ?? undefined),
          identity,
          underOwnMessage,
        ).pipe(
          Effect.as("ok" as const),
          Effect.catch((error) =>
            Effect.logWarning("slack reply post failed").pipe(
              Effect.annotateLogs({ channel: row.chatId, cause: error.message }),
              Effect.as(slackSendOutcome(error.message)),
            ),
          ),
        );
      }),
    sendFile: (row, path) =>
      Effect.gen(function* () {
        const runtime = runtimes.get(row.connectorProjectId);
        const web = runtime?.web ?? null;
        if (web === null || runtime === undefined) return "retry";
        // A failed upload is reported into the chat by sendSlackFile itself.
        yield* sendSlackFile({
          web,
          botToken: runtime.botToken,
          channel: row.chatId,
          threadTs: row.replyThread ?? undefined,
          filePath: path,
          identity: yield* identityForRow(row, runtime),
        }).pipe(Effect.ignore);
        return "ok";
      }),
    onSettled: (row, delivered) =>
      Effect.gen(function* () {
        const hotKey = readMeta(row).hotKey;
        if (delivered && typeof hotKey === "string") yield* markHotWindow(hotKey);
        const key = replyRowKey(row);
        const web = runtimes.get(row.connectorProjectId)?.web ?? null;
        if (web !== null && row.replyTo !== null) {
          const replyTo = row.replyTo;
          yield* Effect.tryPromise(() =>
            web.reactions.remove({
              channel: row.chatId,
              timestamp: replyTo,
              name: WORKING_REACTION,
            }),
          ).pipe(Effect.ignore);
        }
        yield* Ref.update(reactedRef, (set) => {
          const next = new Set(set);
          next.delete(key);
          return next;
        });
      }),
  });

  // Annotated: a DM waiting for "who is this for?" replays through it.
  const handleMessage = (
    projectId: ProjectId,
    config: ManagerSlackConnectorConfig,
    web: WebClient,
    botUserId: string,
    event: SlackRawEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const channel = event.channel;
      const ts = event.ts;
      if (channel === undefined || ts === undefined) return;
      // Skip edits, joins, bot_message — only plain new messages and file shares.
      if (event.subtype !== undefined && event.subtype !== "file_share") return;
      const rawText = typeof event.text === "string" ? event.text : "";
      const files = event.files ?? [];
      if (rawText.trim().length === 0 && files.length === 0) return;
      // Other assistants of this computer that write through this app.
      const routed = yield* routedSlackRowsOf(projectId);
      const allowedHere =
        config.allowedChannelIds.includes(channel) ||
        routed.some((row) => row.config.allowedChannelIds.includes(channel));
      if (!allowedHere) {
        yield* Effect.logDebug("slack message from non-allowlisted channel ignored").pipe(
          Effect.annotateLogs({ projectId, channel }),
        );
        return;
      }
      const senderIsBot = event.bot_id !== undefined || event.user === botUserId;
      const isDM = event.channel_type === "im";
      // An allowlisted channel is not an allowlisted person: only the owner
      // drives the assistant (full access); other members are ignored unless
      // the owner let them in, and then run approval-required.
      const senderRole: ConnectorSenderRole = classifySlackSender({
        userId: event.user,
        senderIsBot,
        isDirectMessage: isDM,
        ownerUserIds: [
          ...(config.ownerUserIds ?? []),
          ...routed.flatMap((row) => row.config.ownerUserIds ?? []),
        ],
        groupMembers: config.groupMembers,
      });
      if (senderRole === "ignore") {
        yield* Effect.logDebug("slack message from a non-owner sender ignored").pipe(
          Effect.annotateLogs({ projectId, channel }),
        );
        return;
      }
      if (isDM && event.user !== undefined) {
        yield* rememberSlackOwner(projectId, event.user);
      }

      // Which assistant answers: the channel's, or for a DM the one the
      // person named ("who is this for?"); the holder alone answers all.
      let assistantId: ProjectId = projectId;
      let identity: SlackIdentity | null = null;
      if (routed.length > 0) {
        const runtime = runtimes.get(projectId);
        if (!isDM) {
          assistantId = ProjectId.make(
            assistantForSlackChannel({
              channel,
              holder: projectId,
              routed: routed.map((row) => ({
                projectId: row.projectId,
                allowedChannelIds: row.config.allowedChannelIds,
              })),
            }),
          );
        } else {
          const choices = yield* choicesOf(projectId, routed);
          const dmKey = { kind: "slack" as const, chatId: channel };
          const pendingKey = `${projectId}:${channel}`;
          const bind = (target: ProjectId) =>
            bindingRepository.upsert({
              ...dmKey,
              connectorProjectId: projectId,
              target: { kind: "assistant", projectId: target },
              notifyOnComplete: false,
              updatedAt: new Date().toISOString(),
            });
          const takePending = Ref.modify(pendingDmRef, (map) => {
            const pending = map.get(pendingKey);
            const next = new Map(map);
            next.delete(pendingKey);
            return [
              pending !== undefined && Date.now() - pending.at < PENDING_DM_MS
                ? pending.event
                : null,
              next,
            ] as const;
          });
          const named = matchAssistantName(rawText, choices);
          if (named !== null) {
            yield* bind(ProjectId.make(named.projectId));
            const namedRuntimeIdentity = yield* identityOf(
              ProjectId.make(named.projectId),
              runtime,
            );
            yield* postMessage(
              web,
              channel,
              slackNowAnswers(named.title),
              undefined,
              namedRuntimeIdentity,
            );
            const pending = yield* takePending;
            if (pending !== null) yield* handleMessage(projectId, config, web, botUserId, pending);
            return;
          }
          const binding = bindingOnConnector(
            Option.getOrNull(
              yield* bindingRepository.get(dmKey).pipe(Effect.orElseSucceed(() => Option.none())),
            ),
            projectId,
          );
          const boundTarget =
            binding?.target.kind === "assistant" ? binding.target.projectId : null;
          const bound =
            boundTarget !== null && choices.some((choice) => choice.projectId === boundTarget)
              ? boundTarget
              : null;
          if (bound !== null) {
            assistantId = bound;
          } else {
            const fallback = ProjectId.make(defaultSlackAssistant(choices, projectId));
            const pending = yield* takePending;
            if (pending === null) {
              // First message of this DM: ask, keep the message.
              yield* Ref.update(pendingDmRef, (map) =>
                new Map(map).set(pendingKey, { event, at: Date.now() }),
              );
              const fallbackTitle =
                choices.find((choice) => choice.projectId === fallback)?.title ?? "Uno";
              yield* postMessage(
                web,
                channel,
                slackWhoIsThisFor(choices, fallbackTitle),
                undefined,
              );
              return;
            }
            // Not a name: the default assistant takes both messages.
            yield* bind(fallback);
            yield* handleMessage(projectId, config, web, botUserId, pending);
            assistantId = fallback;
          }
        }
        const routedRow = routed.find((row) => row.projectId === assistantId);
        if (routedRow !== undefined && !routedRow.config.enabled) {
          if (isDM) {
            yield* postMessage(
              web,
              channel,
              "This assistant is paused in Uno Work. Send another assistant's name to talk to it.",
              undefined,
            );
          }
          return;
        }
        identity = yield* identityOf(assistantId, runtime);
      }
      const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
      const ownerChatKey = slackChatKey(channel, isDM ? null : (threadTs ?? ts));
      // Members never share (or widen) the owner's session.
      const chatKey = senderRole === "member" ? `${ownerChatKey}#members` : ownerChatKey;
      const runtimeMode = senderRole === "member" ? "approval-required" : "full-access";
      const addressing =
        routed.find((row) => row.projectId === assistantId)?.config.addressing ??
        config.addressing ??
        DEFAULT_ADDRESSING_CONFIG;
      const mentionToken = `<@${botUserId}>`;
      const cleanedText = rawText.split(mentionToken).join(" ").replace(/\s+/g, " ").trim();

      const existing = yield* connectorRepository
        .getThreadForChat({ projectId: assistantId, kind: "slack", chatId: chatKey })
        .pipe(Effect.orElseSucceed(() => Option.none<ThreadId>()));
      const hotKey = `${assistantId}:${chatKey}`;
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

      // A replayed event already has its reply on the way: one turn per message.
      const replyKey = `${channel}:${ts}`;
      if (yield* replies.isKnown(projectId, replyKey)) return;
      const title = isDM ? `Slack DM ${channel}` : `Slack: ${channel}`;
      const threadId = yield* ensureThreadForChat({
        projectId: assistantId,
        chatKey,
        title: senderRole === "member" ? `${title} (members)` : title,
        config,
        runtimeMode,
      });
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
      yield* replies.enqueue({
        connectorProjectId: projectId,
        replyKey,
        chatId: channel,
        replyTo: ts,
        // DMs reply flat; channel replies land in the message's thread.
        replyThread: isDM ? null : (threadTs ?? ts),
        threadId,
        language: detectReplyLanguage(cleanedText, null),
        dispatch: {
          text: body,
          attachments: ingested.attachments,
          runtimeMode,
          interactionMode: "default",
        },
        extraMeta: { hotKey, identityProjectId: identity === null ? null : assistantId },
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
    runtime?.stopRelay?.();
    runtimes.delete(projectId);
  };

  // Relay mode: the console queue replaces the socket. Events reach the same
  // `dispatchRawEvent` Socket Mode uses; only `event_callback` payloads of
  // the two event types the socket subscribes to are routed.
  const startRelayEvents = (input: {
    readonly projectId: ProjectId;
    readonly relayToken: string;
    readonly config: ManagerSlackConnectorConfig;
    readonly web: WebClient;
    readonly botUserId: string;
  }): (() => void) => {
    const handle = (payload: SlackEventsApiPayload) =>
      Effect.sync(() => {
        const event = payload.event as SlackRawEvent | undefined;
        if (
          payload.type === "event_callback" &&
          (event?.type === "message" || event?.type === "app_mention")
        ) {
          dispatchRawEvent(input.projectId, input.config, input.web, input.botUserId, event);
        }
      });
    const fiber = runFork(
      runSlackRelayEventLoop({
        key: { projectId: input.projectId, kind: "slack" },
        relayToken: input.relayToken,
        handle,
        onStatus: ({ connected, error }) => {
          const runtime = runtimes.get(input.projectId);
          if (runtime === undefined) return;
          runtime.relayConnected = connected;
          runtime.lastError = error;
        },
      }).pipe(
        Effect.provideService(ManagerConnectorRepository, connectorRepository),
        Effect.catch((cause) =>
          Effect.logWarning("slack relay event loop stopped").pipe(
            Effect.annotateLogs({ projectId: input.projectId, cause: String(cause) }),
          ),
        ),
        Effect.andThen(
          Effect.sync(() => {
            // The loop only ends on a state failure: let reconcile restart it.
            const runtime = runtimes.get(input.projectId);
            if (runtime !== undefined && runtime.stopRelay === stop) {
              runtime.stopRelay = null;
              runtime.relayConnected = false;
              runtime.lastError = "Slack relay stopped; retrying.";
            }
          }),
        ),
      ),
    );
    const stop = () => {
      runFork(Fiber.interrupt(fiber));
    };
    return stop;
  };

  const startConnection = (projectId: ProjectId, config: ManagerSlackConnectorConfig) =>
    Effect.gen(function* () {
      const relayToken = parseRelayCredential(config.botToken);
      const web = makeSlackWebClient(config.botToken);
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
          lastError:
            relayToken === null
              ? "auth.test failed — check the bot token."
              : "Could not reach Slack through Uno — the app may have been removed from the workspace.",
          client: null,
          web: null,
          stopRelay: null,
          relayConnected: false,
        });
        return;
      }
      const botUserId = auth.user_id;
      const botUserName = typeof auth.user === "string" ? auth.user : null;
      // X-OAuth-Scopes (the relay passes it on): may it write as an assistant?
      const scopes = (auth as { response_metadata?: { scopes?: unknown } }).response_metadata
        ?.scopes;
      const canCustomize = Array.isArray(scopes) ? scopes.includes("chat:write.customize") : null;
      if (relayToken !== null) {
        const runtime: SlackRuntime = {
          appToken: config.appToken,
          botToken: config.botToken,
          configJson: JSON.stringify(config),
          botUserId,
          botUserName,
          lastError: null,
          client: null,
          web,
          stopRelay: null,
          relayConnected: false,
          canCustomize,
        };
        runtimes.set(projectId, runtime);
        runtime.stopRelay = startRelayEvents({ projectId, relayToken, config, web, botUserId });
        return;
      }
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
        stopRelay: null,
        relayConnected: false,
        canCustomize,
      });
    });

  const reconcile = Effect.gen(function* () {
    const records = yield* connectorRepository
      .listByKind("slack")
      .pipe(Effect.orElseSucceed(() => []));
    const enabled = new Map<ProjectId, ManagerSlackConnectorConfig>();
    for (const record of records) {
      const decoded = Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(record.config);
      // A routed row (`unoroute:`) has no connection: its holder's carries it.
      if (
        decoded._tag === "Success" &&
        decoded.value.enabled &&
        parseRouteCredential(decoded.value.botToken) === null
      ) {
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
    // `startConnection` never fails — a bad token or a refused Socket Mode
    // handshake is recorded as the runtime's `lastError` and surfaced in the
    // connector status, so there is nothing here to catch.
    for (const [projectId, config] of enabled) {
      if (!hasEventSource(runtimes.get(projectId))) {
        yield* startConnection(projectId, config);
      }
    }
  });

  yield* Effect.forkScoped(
    Effect.forever(reconcile.pipe(Effect.andThen(Effect.sleep(RECONCILE_INTERVAL)))),
  );
  // Sockets and relay pollers live outside the Effect scope; close them with it.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      // Deleting the current key while iterating a Map is safe.
      for (const projectId of runtimes.keys()) stopConnection(projectId);
    }),
  );

  const sendText: ManagerSlackServiceShape["sendText"] = (input) =>
    Effect.gen(function* () {
      // A routed assistant writes through its holder's connection, as itself.
      const holder = yield* holderOf(input.projectId);
      const runtime = runtimes.get(holder);
      const as = input.asAssistant ?? (holder !== input.projectId ? input.projectId : undefined);
      const shared =
        as !== undefined && (as !== holder || (yield* routedSlackRowsOf(holder)).length > 0);
      const identity = shared ? yield* identityOf(as, runtime) : null;
      if (runtime?.web == null) {
        yield* Effect.logWarning("slack push skipped: no live connection").pipe(
          Effect.annotateLogs({ projectId: input.projectId, channel: input.channelId }),
        );
        return false;
      }
      return yield* postMessage(
        runtime.web,
        input.channelId,
        input.text,
        input.threadTs,
        identity,
      ).pipe(
        Effect.map(() => true),
        Effect.catch(() => Effect.succeed(false)),
      );
    });

  return {
    getRuntimeStatus: (requested) =>
      Effect.map(holderOf(requested), (projectId) => {
        const runtime = runtimes.get(projectId);
        return {
          botUserId: runtime?.botUserId ?? null,
          botUserName: runtime?.botUserName ?? null,
          lastError: runtime?.lastError ?? null,
          connected:
            runtime !== undefined &&
            (runtime.client !== null || (runtime.stopRelay !== null && runtime.relayConnected)),
        };
      }),
    sendText,
    listChannels: (projectId) =>
      Effect.gen(function* () {
        const runtime = runtimes.get(yield* holderOf(projectId));
        const web = runtime?.web ?? null;
        if (web === null) return null;
        const answer = yield* Effect.tryPromise(() =>
          web.conversations.list({
            types: "public_channel,private_channel",
            exclude_archived: true,
            limit: 500,
          }),
        ).pipe(Effect.orElseSucceed(() => null));
        if (answer === null) return null;
        return (
          (answer.channels ?? []) as ReadonlyArray<{
            id?: string;
            name?: string;
            is_private?: boolean;
            is_member?: boolean;
          }>
        ).flatMap((channel) =>
          typeof channel.id === "string"
            ? [
                {
                  id: channel.id,
                  name: channel.name ?? channel.id,
                  isPrivate: channel.is_private === true,
                  isMember: channel.is_member === true,
                },
              ]
            : [],
        );
      }),
    joinChannel: (projectId, channelId) =>
      Effect.gen(function* () {
        const runtime = runtimes.get(yield* holderOf(projectId));
        const web = runtime?.web ?? null;
        if (web === null) return false;
        return yield* Effect.tryPromise(() => web.conversations.join({ channel: channelId })).pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      }),
  } satisfies ManagerSlackServiceShape;
});

export const ManagerSlackServiceLive = Layer.effect(ManagerSlackService, makeSlackConnector).pipe(
  Layer.provide(
    Layer.mergeAll(ProjectionTurnRepositoryLive, ManagerConnectorPendingReplyRepositoryLive),
  ),
);
