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
  ProjectId,
  slackChatKey,
  ThreadId,
  UNO_GATEWAY_BASE_URL,
  type ModelSelection,
} from "@t3tools/contracts";
import { Context, Data, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import * as crypto from "node:crypto";

import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorRepository } from "../../persistence/Services/ManagerConnectors.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { DEFAULT_ADDRESSING_CONFIG, decideAddressing } from "../addressing.ts";
import type { AddressingReason } from "../addressing.ts";
import { classifyWake } from "../wakeClassifier.ts";
import { resolveTurnReply } from "./TelegramConnector.ts";

export interface ManagerSlackRuntimeStatus {
  readonly botUserId: string | null;
  readonly botUserName: string | null;
  readonly lastError: string | null;
}

export interface ManagerSlackServiceShape {
  readonly getRuntimeStatus: (
    projectId: ProjectId,
  ) => Effect.Effect<ManagerSlackRuntimeStatus>;
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
// Dedup window: Slack delivers the same message as both `app_mention` and
// `message.channels`, and retries on missed acks; keyed by channel:ts.
const SEEN_TTL_MS = 5 * 60 * 1000;

class SlackConnectorError extends Data.TaggedError("SlackConnectorError")<{
  readonly message: string;
}> {}

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
}

interface SlackRuntime {
  readonly appToken: string;
  readonly botToken: string;
  botUserId: string | null;
  botUserName: string | null;
  lastError: string | null;
  client: SocketModeClient | null;
  web: WebClient | null;
}

const makeSlackConnector = Effect.gen(function* () {
  const connectorRepository = yield* ManagerConnectorRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;

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
        const text = reply.text.trim().length > 0 ? reply.text : "Done.";
        yield* postMessage(input.web, input.channel, text, input.threadTs);
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
      // Skip edits, joins, bot_message, file shares — only plain new messages.
      if (event.subtype !== undefined) return;
      const rawText = typeof event.text === "string" ? event.text : "";
      if (rawText.trim().length === 0) return;
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
      const requestedAtIso = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`slack:${crypto.randomUUID()}`),
        threadId,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text: cleanedText,
          attachments: [],
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
      if (
        config === undefined ||
        config.appToken !== runtime.appToken ||
        config.botToken !== runtime.botToken
      ) {
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

export const ManagerSlackServiceLive = Layer.effect(
  ManagerSlackService,
  makeSlackConnector,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
