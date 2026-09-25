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
 * Where a chat's messages go is a binding (`manager_connector_bindings`,
 * ADR 2026-09-11): the assistant that owns the bot (default), a regular
 * project, or one specific thread — switched from the chat itself with
 * `/use`, `/thread`, `/assistant` (see `connectorCommands.ts`). Routing per
 * target is decided in `connectorBindings.ts#decideThreadRouting`.
 *
 * Thread lifecycle per chat (assistant / project targets): one thread per
 * (target project, chatId), reused while it stays alive AND still matches
 * the selection it should run on (the connector's harness for the assistant,
 * the project's default model otherwise). Changing that selection (or
 * archiving the thread) makes the next message start a fresh thread, seeded
 * with a compact transcript of the previous one.
 *
 * Config lives in `manager_assistant_connectors` and is re-read between poll
 * cycles, so saving settings takes effect without a restart.
 *
 * Delivery is durable: every update is written to `manager_connector_inbox`
 * before it is handled, and the `getUpdates` offset is persisted in
 * `manager_connector_state` only after the update is terminal there
 * (see `connectorInbox.ts`). A restart resumes from the persisted offset and
 * replays unhandled rows. Health (connected / reconnecting / auth_expired /
 * delivery_failed / provider_unavailable) is derived in `connectorHealth.ts`
 * and persisted alongside, so the settings UI can show it.
 */
import { cleanUnoFinalAnswerText } from "@t3tools/shared/unoFinalAnswer";
import { findMarkedAssistantChat } from "@t3tools/shared/assistantChat";
import {
  ASSISTANT_PROJECT_ID,
  CommandId,
  ManagerTelegramConnectorConfig,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  UNO_GATEWAY_BASE_URL,
  type ChatImageAttachment,
  type ManagerConnectorBindingTarget,
  type ManagerConnectorHealth,
  type ManagerConnectorHealthStatus,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Context, Data, Duration, Effect, Layer, Option, Ref, Schema, type Scope } from "effect";
import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildTranscriptMessageText,
  isTranscribableMedia,
  transcribeTelegramAudio,
} from "../telegramTranscription.ts";
import {
  DEFAULT_ADDRESSING_CONFIG,
  decideAddressing,
  type AddressingReason,
} from "../addressing.ts";
import { classifyWake } from "../wakeClassifier.ts";
import {
  attemptWithBackoff,
  classifyTelegramApiError,
  INITIAL_CONNECTOR_HEALTH,
  isBackingOff,
  isRetriableTelegramApiError,
  onDeliveryOutcome,
  onPollFailure,
  onPollSuccess,
  SEND_RETRY_DELAYS_MS,
  type ConnectorFailure,
  type ConnectorHealthRuntime,
  type HealthTransition,
} from "../connectorHealth.ts";
import {
  processInboxEvents,
  recoverPendingEvents,
  type ConnectorInboxHandler,
} from "../connectorInbox.ts";
import { ServerConfig } from "../../config.ts";
import { telegramCommandOrigin } from "../../orchestration/commandOrigin.ts";
import {
  buildHandoffContext as buildSharedHandoffContext,
  stripHandoffPreamble,
  TELEGRAM_HANDOFF_OPTIONS,
  wrapHandoffPreamble,
} from "../../orchestration/handoff.ts";
import { inheritProjectThreadModes } from "../../orchestration/projectThreadModes.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepository } from "../../persistence/Services/ManagerConnectorBindings.ts";
import {
  ManagerConnectorRepository,
  type ManagerConnectorKey,
} from "../../persistence/Services/ManagerConnectors.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import {
  decideThreadRouting,
  effectiveBindingTarget,
  type RoutingThreadShell,
} from "../connectorBindings.ts";
import { executeConnectorCommand } from "../connectorCommandHandler.ts";
import { currentAssistantModelSelection } from "../assistantEngineSelection.ts";
import { parseConnectorCommand } from "../connectorCommands.ts";
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
  toNormalizedMessage,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
  TELEGRAM_BOT_UPLOAD_LIMIT_BYTES,
  TELEGRAM_SEND_FILE_HINT,
  type TelegramIncomingMessage,
  type TelegramMediaDescriptor,
} from "../telegramMedia.ts";
import { renderTelegramHtml } from "../telegramMarkdown.ts";
import {
  matchesTelegramPairing,
  newTelegramPairing,
  parseTelegramStartPayload,
  shouldReplyToStranger,
  TELEGRAM_PAIRING_TTL_MS,
  telegramLinkedReply,
  telegramStrangerReply,
  type TelegramPairing,
} from "../telegramPairing.ts";
import {
  callTelegramBotMethod,
  isRelayCredential,
  redactConnectorSecrets,
  RELAY_CREDENTIAL_PREFIX,
  telegramApiUrl,
  telegramFileUrl,
} from "../channelRelay.ts";

export interface ManagerTelegramRuntimeStatus {
  readonly botUsername: string | null;
  readonly lastError: string | null;
  /** Persisted health; null until the poller has observed the connector. */
  readonly health: ManagerConnectorHealth | null;
}

export interface ManagerTelegramServiceShape {
  readonly getRuntimeStatus: (projectId: ProjectId) => Effect.Effect<ManagerTelegramRuntimeStatus>;
  /**
   * Proactively push text to a Telegram chat (reminders, notifications) — not
   * a reply to an inbound message. Resolves the bot token from the project's
   * connector config. Returns whether Telegram accepted the message; never
   * fails, so callers can treat a `false` as "delivery failed" and move on.
   */
  readonly sendText: (input: {
    readonly projectId: ProjectId;
    readonly chatId: string;
    readonly text: string;
  }) => Effect.Effect<boolean>;
  /**
   * Issue the one-time code the app shows as the bot's deep link
   * (telegramPairing.ts). A new code replaces the previous one. On a relay
   * connector (Uno's shared bot) the code is also registered with the
   * console (`unoRegisterStartCode`) — the shared bot only routes
   * `/start <code>` to this computer for a registered code — and a failed
   * registration fails the call.
   */
  readonly startPairing: (projectId: ProjectId) => Effect.Effect<
    {
      readonly code: string;
      readonly expiresAt: string;
      readonly botUsername: string | null;
    },
    TelegramPairingError
  >;
  /**
   * Send a test message to every linked chat; per chat whether Telegram
   * accepted it (and why not).
   */
  readonly sendTestMessage: (input: {
    readonly projectId: ProjectId;
    readonly text: string;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly chatId: string; readonly ok: boolean; readonly error: string | null }>
  >;
}

export class ManagerTelegramService extends Context.Service<
  ManagerTelegramService,
  ManagerTelegramServiceShape
>()("t3/manager/Services/ManagerTelegramService") {}

const POLL_TIMEOUT_SECONDS = 10;
const IDLE_RECHECK = Duration.seconds(5);
// Persist `last_ok_at` on a healthy connector at most this often: the fact
// that it is still fine does not need a write per 10-second long poll.
const OK_PERSIST_INTERVAL = Duration.minutes(1);
// Terminal inbox rows older than this are pruned; the dedupe window only has
// to outlive Telegram's own retention of unconfirmed updates (24h).
const INBOX_RETENTION = Duration.days(7);
const INBOX_PRUNE_INTERVAL = Duration.hours(1);
const REPLY_POLL_INTERVAL = Duration.seconds(2);
const REPLY_TIMEOUT = Duration.minutes(10);
const TYPING_ACTION_INTERVAL = Duration.seconds(4);
// Hermes (ACP) резолвит session/prompt раньше, чем достримит текст ответа:
// turn в проекции уже терминален, а сообщение ассистента приходит секундами
// позже. Терминальному turn'у без текста даём этот grace-период на дозапись
// сообщения, прежде чем сдаться и отправить "Turn finished with state".
const TERMINAL_REPLY_GRACE = Duration.seconds(45);
const TELEGRAM_MESSAGE_LIMIT = 4000;
// Session statuses that mean the harness runtime is gone and the turn will
// never reach a terminal state on its own.
const DEAD_SESSION_STATUSES: ReadonlySet<string> = new Set(["stopped", "error"]);

// The handoff preamble (carrying recent history of the old thread into the
// replacement thread) is shared with "Continue on <machine>"; see
// `orchestration/handoff.ts`. Re-exported for the connector tests.
export { stripHandoffPreamble };

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
        (candidate) => candidate.turnId !== null && candidate.requestedAt >= input.requestedAtIso,
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
  const stillRunning = turn === null || turn.state === "pending" || turn.state === "running";
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
    // The final-answer marker some models echo never goes out to a chat.
    const { text, files } = extractOutgoingFiles(
      cleanUnoFinalAnswerText(lastAssistantMessage.text),
    );
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

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramIncomingMessage;
}

/** Shape check for an inbox payload replayed after a restart. */
export const decodeStoredTelegramUpdate = (payload: unknown): TelegramUpdate | null =>
  typeof payload === "object" &&
  payload !== null &&
  typeof (payload as { update_id?: unknown }).update_id === "number"
    ? (payload as TelegramUpdate)
    : null;

/** Telegram's resume cursor: one past the last update we settled. */
export const telegramOffsetAfter = (update: TelegramUpdate): number => update.update_id + 1;

interface BotRuntime {
  /**
   * Bot token this runtime was built for. A different token in the config
   * means the owner swapped bots: the runtime (and the persisted offset) are
   * rebuilt for it. Null until the connector is first seen in this process.
   */
  botToken: string | null;
  /** In-memory mirror of the persisted `getUpdates` offset. */
  offset: number;
  botUsername: string | null;
  lastError: string | null;
  health: ConnectorHealthRuntime;
  lastOkPersistedAtMs: number;
}

const INITIAL_BOT_RUNTIME: BotRuntime = {
  botToken: null,
  offset: 0,
  botUsername: null,
  lastError: null,
  health: INITIAL_CONNECTOR_HEALTH,
  lastOkPersistedAtMs: 0,
};

// Own bot → api.telegram.org; `unorelay:<tgr>` → the console's Bot-API
// mirror (channelRelay.ts). Every Bot-API URL of this connector goes here.
const telegramApi = telegramApiUrl;

/** Ошибка Telegram Bot API / файловой системы — только сообщение, поллер её логирует. */
class TelegramConnectorError extends Data.TaggedError("TelegramConnectorError")<{
  readonly message: string;
}> {}

/**
 * The chat's binding cannot be served (bound thread gone / archived, project
 * without a model). Reported to the chat as plain text; the update counts as
 * handled — retrying would not change the answer.
 */
class TelegramRoutingError extends Data.TaggedError("TelegramRoutingError")<{
  readonly message: string;
}> {}

/** Telegram answered `{ ok: false }`; `errorCode` decides retry/health handling. */
class TelegramApiRejection extends Data.TaggedError("TelegramApiRejection")<{
  readonly errorCode: number | undefined;
  readonly description: string;
}> {}

interface TelegramApiResponse {
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly description?: string;
  readonly error_code?: number;
}

const fetchJson = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, init);
      return (await response.json()) as TelegramApiResponse;
    },
    catch: (cause) =>
      new TelegramConnectorError({
        message: `Telegram request failed: ${redactConnectorSecrets(String(cause))}`,
      }),
  });

/**
 * Identity of the update stream the persisted offset belongs to. A relay
 * token rotates (every "Connect with Uno's bot" mints a new one) while the
 * relay queue — and its update ids — stays the same, so all relay tokens
 * share one fingerprint: rotation must not replay or drop the queue.
 */
export const credentialFingerprint = (botToken: string): string =>
  crypto
    .createHash("sha256")
    .update(isRelayCredential(botToken) ? RELAY_CREDENTIAL_PREFIX : botToken)
    .digest("hex")
    .slice(0, 16);

/** Registering a relay link code with the console failed; the link would not work. */
export class TelegramPairingError extends Data.TaggedError("TelegramPairingError")<{
  readonly message: string;
}> {}

const makeTelegramConnector = Effect.gen(function* () {
  const connectorRepository = yield* ManagerConnectorRepository;
  const bindingRepository = yield* ManagerConnectorBindingRepository;
  const pendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverConfig = yield* ServerConfig;
  const serverSettingsService = yield* ServerSettingsService;

  // Non-image incoming files land here; the harness reads them by absolute
  // path (assistant threads run in full access; a project / thread target
  // may ask for approval to read them, which the chat resolves with /approve).
  const telegramFilesDir = nodePath.join(serverConfig.stateDir, "telegram-files");

  const runtimesRef = yield* Ref.make<ReadonlyMap<ProjectId, BotRuntime>>(new Map());
  // Pending link codes (telegramPairing.ts), one per assistant; in memory —
  // a restart only means pressing "Get a new link".
  const pairingsRef = yield* Ref.make<ReadonlyMap<ProjectId, TelegramPairing>>(new Map());
  // When a not-linked private chat last heard the "how to link" hint.
  const strangerRepliesRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const updateRuntime = (projectId: ProjectId, patch: Partial<BotRuntime>) =>
    Ref.update(runtimesRef, (runtimes) => {
      const next = new Map(runtimes);
      const current = next.get(projectId) ?? INITIAL_BOT_RUNTIME;
      next.set(projectId, { ...current, ...patch });
      return next;
    });

  const getRuntime = (projectId: ProjectId) =>
    Ref.get(runtimesRef).pipe(
      Effect.map((runtimes) => runtimes.get(projectId) ?? INITIAL_BOT_RUNTIME),
    );

  const connectorKey = (projectId: ProjectId): ManagerConnectorKey => ({
    projectId,
    kind: "telegram",
  });

  // Apply a health transition: in-memory runtime, persisted state row, and a
  // warning line — the latter only when the transition says one is due
  // (status change, or a minute since the last one for this connector).
  const applyHealthTransition = (input: {
    readonly projectId: ProjectId;
    readonly transition: HealthTransition;
    readonly error: string | null;
    readonly context: string;
  }) =>
    Effect.gen(function* () {
      const { projectId, transition } = input;
      const nowMs = Date.now();
      const runtime = yield* getRuntime(projectId);
      const healthy = transition.status === "connected";
      const persist =
        !healthy ||
        transition.statusChanged ||
        nowMs - runtime.lastOkPersistedAtMs >= Duration.toMillis(OK_PERSIST_INTERVAL);
      yield* updateRuntime(projectId, {
        health: transition.runtime,
        lastError: healthy ? null : input.error,
        ...(persist && healthy ? { lastOkPersistedAtMs: nowMs } : {}),
      });
      if (persist) {
        yield* connectorRepository
          .recordHealth({
            ...connectorKey(projectId),
            status: transition.status,
            error: healthy ? null : input.error,
            at: new Date(nowMs).toISOString(),
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("telegram connector health persist failed").pipe(
                Effect.annotateLogs({ projectId, cause }),
              ),
            ),
          );
      }
      if (transition.shouldWarn) {
        yield* Effect.logWarning(`telegram connector ${transition.status}`).pipe(
          Effect.annotateLogs({ projectId, context: input.context, error: input.error }),
        );
      } else if (transition.statusChanged && healthy) {
        yield* Effect.logInfo("telegram connector connected").pipe(
          Effect.annotateLogs({ projectId }),
        );
      }
    });

  const recordPollFailure = (projectId: ProjectId, failure: ConnectorFailure, context: string) =>
    Effect.gen(function* () {
      if (failure.kind === "delivery") {
        return;
      }
      const runtime = yield* getRuntime(projectId);
      yield* applyHealthTransition({
        projectId,
        transition: onPollFailure(runtime.health, failure.kind, Date.now()),
        error: failure.message,
        context,
      });
    });

  const recordPollSuccess = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const runtime = yield* getRuntime(projectId);
      yield* applyHealthTransition({
        projectId,
        transition: onPollSuccess(runtime.health, Date.now()),
        error: null,
        context: "poll",
      });
    });

  const recordDelivery = (projectId: ProjectId, delivered: boolean, error: string | null) =>
    Effect.gen(function* () {
      const runtime = yield* getRuntime(projectId);
      const transition = onDeliveryOutcome(runtime.health, delivered, Date.now());
      if (transition === null) {
        return;
      }
      yield* applyHealthTransition({ projectId, transition, error, context: "send" });
    });

  const healthFromState = (
    state: Option.Option<{
      readonly status: ManagerConnectorHealthStatus | null;
      readonly lastOkAt: string | null;
      readonly lastError: string | null;
      readonly lastErrorAt: string | null;
    }>,
  ): ManagerConnectorHealth | null =>
    Option.isSome(state) && state.value.status !== null
      ? {
          status: state.value.status,
          lastOkAt: state.value.lastOkAt,
          lastError: state.value.lastError,
          lastErrorAt: state.value.lastErrorAt,
        }
      : null;

  // Last time the bot replied to a chat, keyed `${projectId}:${chatId}`. Feeds
  // the addressing "hot window": for a few seconds after a reply, follow-ups
  // from that chat land without re-addressing the bot.
  const hotWindowRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const hotWindowKey = (projectId: ProjectId, chatId: string): string => `${projectId}:${chatId}`;
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

  // Compact transcript of the old thread, carried into the replacement thread
  // as a preamble on its first turn so the new harness knows what came before.
  // The standing send-file hint is connector plumbing, not conversation — drop it.
  const buildHandoffContext = (thread: OrchestrationThread): string | null =>
    buildSharedHandoffContext(thread, {
      ...TELEGRAM_HANDOFF_OPTIONS,
      sanitize: (text) => text.replace(TELEGRAM_SEND_FILE_HINT, ""),
    });

  const routingShell = (shell: Option.Option<RoutingThreadShell>): RoutingThreadShell | null =>
    Option.isSome(shell) ? shell.value : null;

  // Resolve the thread an addressed message lands in, per the chat's binding
  // target (see `decideThreadRouting`). Creates the per-chat thread when the
  // target is a project / the assistant and none is live on the right
  // selection; never creates anything for a `thread` target.
  const ensureThreadForChat = (input: {
    readonly target: ManagerConnectorBindingTarget;
    readonly chatId: string;
    readonly chatLabel: string;
    readonly config: ManagerTelegramConnectorConfig;
  }) =>
    Effect.gen(function* () {
      const { target } = input;
      const routing = yield* Effect.gen(function* () {
        if (target.kind === "thread") {
          const targetThread = yield* projectionSnapshotQuery.getThreadShellById(target.threadId);
          return decideThreadRouting({
            target,
            mappedThread: null,
            targetThread: routingShell(targetThread),
            connectorModelSelection: null,
            projectModelSelection: null,
            inheritedModes: null,
          });
        }
        const project = yield* projectionSnapshotQuery.getProjectShellById(target.projectId);
        if (Option.isNone(project)) {
          return yield* new TelegramRoutingError({
            message: `This chat is bound to project ${target.projectId}, which no longer exists. Use /use <project> or /assistant.`,
          });
        }
        const existing = yield* connectorRepository.getThreadForChat({
          projectId: target.projectId,
          kind: "telegram",
          chatId: input.chatId,
        });
        const mappedThread = Option.isSome(existing)
          ? routingShell(yield* projectionSnapshotQuery.getThreadShellById(existing.value))
          : null;
        const inheritedModes =
          target.kind === "project"
            ? yield* inheritProjectThreadModes(projectionSnapshotQuery, target.projectId)
            : null;
        return decideThreadRouting({
          target,
          mappedThread,
          targetThread: null,
          // The assistant's chats run on the Uno chat's engine (Hermes).
          assistantModelSelection:
            target.kind === "assistant"
              ? yield* currentAssistantModelSelection(projectionSnapshotQuery)
              : null,
          // The connector-level choice wins for the assistant only: Telegram
          // must never spawn a harness the owner didn't pick for it — while a
          // project target runs on what the project itself is configured for.
          connectorModelSelection: input.config.defaultModelSelection ?? null,
          projectModelSelection: project.value.defaultModelSelection,
          inheritedModes,
        });
      });

      switch (routing.kind) {
        case "reject":
          return yield* new TelegramRoutingError({ message: routing.message });
        case "reuse":
          return {
            threadId: routing.threadId,
            handoffContext: null,
            runtimeMode: routing.runtimeMode,
            interactionMode: routing.interactionMode,
          };
        case "create": {
          let handoffContext: string | null = null;
          if (routing.previousThreadId !== null) {
            const previousDetail = yield* projectionSnapshotQuery
              .getThreadDetailById(routing.previousThreadId)
              .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));
            if (Option.isSome(previousDetail)) {
              handoffContext = buildHandoffContext(previousDetail.value);
            }
          }
          const threadId = ThreadId.make(crypto.randomUUID());
          const createdAt = new Date().toISOString();
          yield* orchestrationEngine.dispatch(
            {
              type: "thread.create",
              commandId: CommandId.make(`telegram:${crypto.randomUUID()}`),
              threadId,
              projectId: routing.projectId,
              title: `Telegram: ${input.chatLabel}`,
              modelSelection: routing.modelSelection,
              runtimeMode: routing.runtimeMode,
              interactionMode: routing.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt,
            },
            { origin: telegramCommandOrigin(input.chatId) },
          );
          yield* connectorRepository.setThreadForChat({
            projectId: routing.projectId,
            kind: "telegram",
            chatId: input.chatId,
            threadId,
            createdAt,
          });
          return {
            threadId,
            handoffContext,
            runtimeMode: routing.runtimeMode,
            interactionMode: routing.interactionMode,
          };
        }
      }
    });

  // Transcribe the first transcribable audio of a message BEFORE the addressing
  // gate, so "Антоха, посмотри" spoken aloud in a smart-wake group can be
  // matched/classified. Returns the transcript + its file_id (reused by the
  // media pipeline to avoid a second STT) or null on any failure.
  const transcribeAudioForGating = (input: {
    readonly botToken: string;
    readonly media: ReadonlyArray<TelegramMediaDescriptor>;
  }) =>
    Effect.gen(function* () {
      const target = input.media.find(
        (descriptor) =>
          isTranscribableMedia(descriptor) &&
          (descriptor.sizeBytes === null ||
            descriptor.sizeBytes <= TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES),
      );
      if (target === undefined) {
        return null;
      }
      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const unoApiKey = settings?.uno.apiKey?.trim() ?? "";
      if (unoApiKey.length === 0) {
        return null;
      }
      const bytes = yield* downloadTelegramFile(input.botToken, target.fileId).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (bytes === null) {
        return null;
      }
      const transcript = yield* transcribeTelegramAudio({
        baseUrl: UNO_GATEWAY_BASE_URL,
        apiKey: unoApiKey,
        bytes,
        fileName: target.fileName,
        mimeType: target.mimeType,
      }).pipe(Effect.catch(() => Effect.succeed(null)));
      return transcript === null ? null : { fileId: target.fileId, transcript };
    });

  // Send a message with bounded retries (network errors, 429, 5xx), then
  // record the outcome as connector health: a rejection after the last
  // attempt puts the connector into `delivery_failed` until a later send
  // succeeds. Never fails — callers get `{ ok: false }` and move on.
  const sendTelegramText = (
    projectId: ProjectId,
    botToken: string,
    chatId: string,
    text: string,
  ): Effect.Effect<{ readonly ok: boolean; readonly description?: string }> =>
    attemptWithBackoff(
      fetchJson(telegramApi(botToken, "sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: renderTelegramHtml(text),
          parse_mode: "HTML",
        }),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok === true
            ? Effect.succeed(response)
            : Effect.fail(
                new TelegramApiRejection({
                  errorCode: response.error_code,
                  description: response.description ?? "unknown error",
                }),
              ),
        ),
      ),
      {
        retriable: (error) =>
          error._tag === "TelegramConnectorError" || isRetriableTelegramApiError(error.errorCode),
        delaysMs: SEND_RETRY_DELAYS_MS,
      },
    ).pipe(
      Effect.tap(() => recordDelivery(projectId, true, null)),
      Effect.map(() => ({ ok: true as const })),
      Effect.catch((error) => {
        const description =
          error._tag === "TelegramApiRejection" ? error.description : error.message;
        return Effect.logWarning("telegram sendMessage failed after retries").pipe(
          Effect.annotateLogs({ projectId, chatId, description }),
          Effect.andThen(recordDelivery(projectId, false, description)),
          Effect.as({ ok: false as const, description }),
        );
      }),
    );

  // «Печатает…» живёт в Telegram ~5 секунд; ошибки индикатора не должны
  // трогать ватчер ответа.
  const sendTelegramTypingAction = (botToken: string, chatId: string) =>
    fetchJson(telegramApi(botToken, "sendChatAction"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    }).pipe(Effect.ignore);

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
          const response = await fetch(telegramFileUrl(botToken, filePath));
          if (!response.ok) {
            throw new Error(`file download failed with status ${response.status}`);
          }
          return new Uint8Array(await response.arrayBuffer());
        },
        catch: (cause) =>
          new TelegramConnectorError({
            message: `Telegram file download failed: ${redactConnectorSecrets(String(cause))}`,
          }),
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
    /**
     * Transcripts already computed while gating the message (voice in a
     * smart-wake group), keyed by file_id, so we never pay the STT twice.
     */
    readonly precomputedTranscripts?: ReadonlyMap<string, string>;
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
        if (!saved) {
          notes.push(buildMediaFailureNote(descriptor, "failed to save the file on the server"));
          continue;
        }

        // Голосовые/кружки транскрибируем через гейтвей: транскрипт попадает
        // в текст сообщения (виден в диалоге приложения и любому харнессу).
        // Нет ключа / гейтвей недоступен — деградация в заметку с путём.
        if (isTranscribableMedia(descriptor)) {
          // Reuse the transcript computed during addressing gating, if any.
          let transcript = input.precomputedTranscripts?.get(descriptor.fileId) ?? null;
          if (transcript === null) {
            const settings = yield* serverSettingsService.getSettings.pipe(
              Effect.orElseSucceed(() => undefined),
            );
            const unoApiKey = settings?.uno.apiKey?.trim() ?? "";
            if (unoApiKey.length > 0) {
              transcript = yield* transcribeTelegramAudio({
                baseUrl: UNO_GATEWAY_BASE_URL,
                apiKey: unoApiKey,
                bytes,
                fileName: descriptor.fileName,
                mimeType: descriptor.mimeType,
              }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("telegram voice transcription failed").pipe(
                    Effect.annotateLogs({ chatId: input.chatId, savedPath, cause: cause.message }),
                    Effect.as(null),
                  ),
                ),
              );
            }
          }
          if (transcript !== null) {
            notes.push(buildTranscriptMessageText({ descriptor, transcript, savedPath }));
            continue;
          }
        }

        notes.push(buildMediaNote(descriptor, savedPath));
      }
      return { attachments, notes };
    });

  // Upload a file the assistant marked with `[[send-file: …]]`. Photos go via
  // sendPhoto (with a sendDocument fallback: Telegram rejects photos over its
  // dimension limits), everything else via sendDocument. Failures are reported
  // into the chat so the user isn't left waiting for a file that never comes.
  const sendTelegramFile = (
    projectId: ProjectId,
    botToken: string,
    chatId: string,
    filePath: string,
  ) =>
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
        yield* sendTelegramText(
          projectId,
          botToken,
          chatId,
          `Could not send ${filePath}: ${failure}`,
        );
      }
    });

  const sendReplyWhenTurnCompletes = (input: {
    readonly projectId: ProjectId;
    readonly botToken: string;
    readonly chatId: string;
    readonly threadId: ThreadId;
    readonly requestedAtIso: string;
    /** Marked with "now" once a real reply lands, opening the hot window. */
    readonly hotKey: string;
  }) =>
    Effect.gen(function* () {
      const deadline = Date.now() + Duration.toMillis(REPLY_TIMEOUT);
      let typingSentAtMs = 0;
      while (Date.now() < deadline) {
        if (Date.now() - typingSentAtMs >= Duration.toMillis(TYPING_ACTION_INTERVAL)) {
          typingSentAtMs = Date.now();
          yield* sendTelegramTypingAction(input.botToken, input.chatId);
        }
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
          yield* sendTelegramText(input.projectId, input.botToken, input.chatId, reply.text);
        } else if (reply.files.length === 0) {
          yield* sendTelegramText(input.projectId, input.botToken, input.chatId, "Done.");
        }
        for (const file of reply.files) {
          yield* sendTelegramFile(input.projectId, input.botToken, input.chatId, file);
        }
        yield* markHotWindow(input.hotKey);
        return;
      }
      yield* sendTelegramText(
        input.projectId,
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

  /**
   * The chat that pressed Start on the app's link: allowlist it (re-reading
   * the stored config so a concurrent save is not lost) and, for the
   * default assistant's private chat, point it at the main conversation.
   * The code is spent.
   */
  const linkChat = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    message: TelegramIncomingMessage,
  ) =>
    Effect.gen(function* () {
      const chatId = String(message.chat?.id);
      yield* Ref.update(pairingsRef, (map) => {
        const next = new Map(map);
        next.delete(projectId);
        return next;
      });
      const stored = yield* connectorRepository.get({ projectId, kind: "telegram" });
      const current = Option.isSome(stored)
        ? Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(stored.value.config)
        : null;
      const base = current !== null && current._tag === "Success" ? current.value : config;
      if (!base.allowedChatIds.includes(chatId)) {
        yield* connectorRepository.upsert({
          projectId,
          kind: "telegram",
          config: { ...base, allowedChatIds: [...base.allowedChatIds, chatId] },
          updatedAt: new Date().toISOString(),
        });
      }
      let toMainConversation = false;
      if (projectId === ASSISTANT_PROJECT_ID && message.chat?.type === "private") {
        const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
        const main = findMarkedAssistantChat(snapshot.threads);
        if (main !== null) {
          const existing = yield* bindingRepository.get({ kind: "telegram", chatId });
          yield* bindingRepository.upsert({
            kind: "telegram",
            chatId,
            connectorProjectId: projectId,
            target: { kind: "thread", threadId: main.id },
            notifyOnComplete: Option.isSome(existing) ? existing.value.notifyOnComplete : false,
            updatedAt: new Date().toISOString(),
          });
          toMainConversation = true;
        }
      }
      yield* Effect.logInfo("telegram chat linked by code").pipe(
        Effect.annotateLogs({ projectId, chatId, toMainConversation }),
      );
      yield* sendTelegramText(
        projectId,
        config.botToken,
        chatId,
        telegramLinkedReply({ toMainConversation }),
      );
    });

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
      const startPayload = parseTelegramStartPayload(text);
      if (startPayload !== null) {
        const pairing = (yield* Ref.get(pairingsRef)).get(projectId);
        if (matchesTelegramPairing(pairing, startPayload, Date.now())) {
          yield* linkChat(projectId, config, message);
          return;
        }
      }
      if (!config.allowedChatIds.includes(chatId)) {
        yield* Effect.logDebug("telegram message from non-allowlisted chat ignored").pipe(
          Effect.annotateLogs({ projectId, chatId }),
        );
        // A private chat hears how to link (at most every few minutes), so
        // the owner is never left talking to a silent bot.
        if (message.chat?.type === "private" && message.from?.is_bot !== true) {
          const nowMs = Date.now();
          const last = (yield* Ref.get(strangerRepliesRef)).get(`${projectId}:${chatId}`);
          if (shouldReplyToStranger(last, nowMs)) {
            yield* Ref.update(strangerRepliesRef, (map) =>
              new Map(map).set(`${projectId}:${chatId}`, nowMs),
            );
            yield* sendTelegramText(
              projectId,
              config.botToken,
              chatId,
              telegramStrangerReply(chatId),
            );
          }
        }
        return;
      }

      const botUsername = (yield* getRuntime(projectId)).botUsername;

      // --- Chat commands (`/use`, `/where`, `/approve`, …) come before the
      // addressing gate: they steer the transport itself and never reach a
      // harness. Anything else is message text for the bound target.
      const command = parseConnectorCommand(text, botUsername);
      if (command !== null) {
        const reply = yield* executeConnectorCommand(
          {
            bindings: bindingRepository,
            projections: projectionSnapshotQuery,
            pendingApprovals: pendingApprovalRepository,
            engine: orchestrationEngine,
          },
          {
            kind: "telegram",
            chatId,
            connectorProjectId: projectId,
            origin: telegramCommandOrigin(chatId),
          },
          command,
        );
        yield* sendTelegramText(projectId, config.botToken, chatId, reply);
        return;
      }

      // --- Addressing gate. Decide whether the bot should react BEFORE
      // creating a thread: a private chat always passes; a group needs an
      // @mention / reply / a (fuzzy) name / an active hot window, or — only if
      // the owner opted in — the smart classifier. Non-addressed group chatter
      // never spawns a thread or a harness session.
      const addressing = config.addressing ?? DEFAULT_ADDRESSING_CONFIG;
      const hotKey = hotWindowKey(projectId, chatId);
      const withinHotWindow = yield* isWithinHotWindow(hotKey, addressing.hotWindowSec);

      let effectiveText = text;
      const precomputedTranscripts = new Map<string, string>();
      let normalized = toNormalizedMessage({ message, botUsername, text: effectiveText });
      let decision = decideAddressing(normalized, addressing, { withinHotWindow });

      // Voice in a group carries no @mention; to catch a spoken name/intent we
      // must transcribe first. Per the owner's choice this happens ONLY with
      // smartWake on (a reply-to-bot already passes the cheap check above), so
      // we never burn STT on every group voice note.
      if (
        !decision.addressed &&
        !normalized.isDirectMessage &&
        addressing.smartWake &&
        media.some(isTranscribableMedia)
      ) {
        const gating = yield* transcribeAudioForGating({ botToken: config.botToken, media });
        if (gating !== null) {
          precomputedTranscripts.set(gating.fileId, gating.transcript);
          effectiveText = [effectiveText, gating.transcript]
            .filter((part) => part.length > 0)
            .join("\n");
          normalized = toNormalizedMessage({ message, botUsername, text: effectiveText });
          decision = decideAddressing(normalized, addressing, { withinHotWindow });
        }
      }

      // Smart tier: cheap checks missed and the owner opted in. Degrades to
      // "stay silent" on any gateway failure — the safe default in a group.
      if (!decision.addressed && decision.needsSmartCheck) {
        const settings = yield* serverSettingsService.getSettings.pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const unoApiKey = settings?.uno.apiKey?.trim() ?? "";
        if (unoApiKey.length > 0) {
          const addressed = yield* classifyWake({
            baseUrl: UNO_GATEWAY_BASE_URL,
            apiKey: unoApiKey,
            names: addressing.names,
            text: effectiveText,
          }).pipe(Effect.catch(() => Effect.succeed(false)));
          if (addressed) {
            decision = { addressed: true, reason: "smart" satisfies AddressingReason };
          }
        }
      }

      if (!decision.addressed) {
        yield* Effect.logDebug("telegram message not addressed to the bot; ignored").pipe(
          Effect.annotateLogs({ projectId, chatId }),
        );
        return;
      }

      const chatLabel = message.chat?.title ?? message.chat?.username ?? chatId;
      // Where this chat's messages go: its binding, or the assistant that
      // owns the bot when it has none.
      const binding = yield* bindingRepository
        .get({ kind: "telegram", chatId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const target = effectiveBindingTarget(Option.getOrNull(binding), projectId);
      const { threadId, handoffContext, runtimeMode, interactionMode } = yield* ensureThreadForChat(
        {
          target,
          chatId,
          chatLabel,
          config,
        },
      );
      const ingested =
        media.length > 0
          ? yield* ingestIncomingMedia({
              botToken: config.botToken,
              threadId,
              chatId,
              media,
              precomputedTranscripts,
            })
          : { attachments: [], notes: [] };
      const bodyParts = [text, ...nonFileLines, ...ingested.notes].filter(
        (part) => part.length > 0,
      );
      if (bodyParts.length === 0) {
        bodyParts.push("[The user sent the attached image(s) without a caption.]");
      }
      const body = [...bodyParts, TELEGRAM_SEND_FILE_HINT].join("\n\n");
      const messageText =
        handoffContext === null ? body : [wrapHandoffPreamble(handoffContext), "", body].join("\n");
      const requestedAtIso = new Date().toISOString();
      yield* orchestrationEngine.dispatch(
        {
          type: "thread.turn.start",
          commandId: CommandId.make(`telegram:${crypto.randomUUID()}`),
          threadId,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text: messageText,
            attachments: ingested.attachments,
          },
          // Inherited from the routing decision: the assistant's fixed mode,
          // or whatever the bound project / thread runs in. Never widened here.
          runtimeMode,
          interactionMode,
          createdAt: requestedAtIso,
        },
        { origin: telegramCommandOrigin(chatId) },
      );
      yield* Effect.forkScoped(
        sendReplyWhenTurnCompletes({
          projectId,
          botToken: config.botToken,
          chatId,
          threadId,
          requestedAtIso,
          hotKey,
        }),
      );
    }).pipe(
      // A binding that cannot be served is an answer for the chat, not a
      // failed delivery: the update is handled, the user is told what to do.
      Effect.catchTag("TelegramRoutingError", (error) =>
        Effect.gen(function* () {
          const chatId = String(update.message?.chat?.id ?? "");
          if (chatId.length === 0) {
            return;
          }
          yield* sendTelegramText(projectId, config.botToken, chatId, error.message);
        }),
      ),
    );

  // Return type inferred: `handleUpdate` carries its own error union, and
  // pinning it here would only duplicate it.
  const inboxHandler = (projectId: ProjectId, config: ManagerTelegramConnectorConfig) => ({
    key: connectorKey(projectId),
    handle: (update: TelegramUpdate) => handleUpdate(projectId, config, update),
    offsetAfter: telegramOffsetAfter,
  });

  const syncOffsetFromState = (projectId: ProjectId) =>
    connectorRepository
      .getState(connectorKey(projectId))
      .pipe(
        Effect.flatMap((state) =>
          Option.isSome(state)
            ? updateRuntime(projectId, { offset: state.value.offset })
            : Effect.void,
        ),
      );

  // First sighting of a connector in this process (or a swapped bot token):
  // bind the persisted state to the token, load the resume offset, and
  // replay whatever the previous run received but never settled.
  const initializeRuntime = (projectId: ProjectId, config: ManagerTelegramConnectorConfig) =>
    Effect.gen(function* () {
      const key = connectorKey(projectId);
      const fingerprint = credentialFingerprint(config.botToken);
      const existing = yield* connectorRepository.getState(key);
      const sameCredential =
        Option.isSome(existing) && existing.value.credentialFingerprint === fingerprint;
      if (!sameCredential) {
        yield* connectorRepository.resetState({
          ...key,
          credentialFingerprint: fingerprint,
          updatedAt: new Date().toISOString(),
        });
      }
      yield* updateRuntime(projectId, {
        ...INITIAL_BOT_RUNTIME,
        botToken: config.botToken,
        offset: sameCredential ? existing.value.offset : 0,
        health: {
          ...INITIAL_CONNECTOR_HEALTH,
          status: sameCredential ? existing.value.status : null,
        },
      });
      const recovered = yield* recoverPendingEvents(inboxHandler(projectId, config), {
        decode: decodeStoredTelegramUpdate,
      });
      if (recovered.handled + recovered.failed + recovered.exhausted > 0) {
        yield* Effect.logInfo("telegram inbox recovered after restart").pipe(
          Effect.annotateLogs({ projectId, ...recovered }),
        );
        yield* syncOffsetFromState(projectId);
      }
    });

  const pollConnector = (projectId: ProjectId, config: ManagerTelegramConnectorConfig) =>
    Effect.gen(function* () {
      let runtime = yield* getRuntime(projectId);
      if (runtime.botToken !== config.botToken) {
        yield* initializeRuntime(projectId, config);
        runtime = yield* getRuntime(projectId);
      }
      if (isBackingOff(runtime.health, Date.now())) {
        return;
      }

      if (runtime.botUsername === null) {
        const me = yield* fetchJson(telegramApi(config.botToken, "getMe"));
        if (me.ok !== true) {
          yield* recordPollFailure(
            projectId,
            classifyTelegramApiError({
              errorCode: me.error_code,
              description: me.description ?? "getMe failed — check the bot token.",
            }),
            "getMe",
          );
          return;
        }
        const username = (me.result as { username?: string } | undefined)?.username ?? null;
        yield* updateRuntime(projectId, { botUsername: username });
      }

      const response = yield* fetchJson(
        telegramApi(config.botToken, "getUpdates") +
          `?timeout=${POLL_TIMEOUT_SECONDS}&offset=${runtime.offset}&allowed_updates=%5B%22message%22%5D`,
      );
      if (response.ok !== true) {
        yield* recordPollFailure(
          projectId,
          classifyTelegramApiError({
            errorCode: response.error_code,
            description: response.description ?? "getUpdates failed.",
          }),
          "getUpdates",
        );
        return;
      }
      yield* recordPollSuccess(projectId);

      const updates = (response.result ?? []) as ReadonlyArray<TelegramUpdate>;
      if (updates.length === 0) {
        return;
      }
      const outcomes = yield* processInboxEvents(
        inboxHandler(projectId, config),
        updates.map((update) => ({ providerEventId: String(update.update_id), payload: update })),
      );
      // Every update is terminal in the inbox now (the repository persisted
      // the cursor per event); mirror the batch end in memory.
      yield* updateRuntime(projectId, {
        offset: updates.reduce(
          (max, update) => Math.max(max, telegramOffsetAfter(update)),
          runtime.offset,
        ),
      });
      const failed = outcomes.filter((outcome) => outcome === "failed").length;
      if (failed > 0) {
        yield* Effect.logWarning("telegram update handling failed").pipe(
          Effect.annotateLogs({ projectId, failed, total: updates.length }),
        );
      }
    }).pipe(
      Effect.catchTag("TelegramConnectorError", (error) =>
        recordPollFailure(projectId, { kind: "network", message: error.message }, "poll"),
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          // Not the provider's fault (SQLite, decode): keep the health status
          // as it was, but make the error visible.
          yield* updateRuntime(projectId, {
            lastError: cause instanceof Error ? cause.message : "Telegram polling failed.",
          });
          yield* Effect.logWarning("telegram poll cycle failed").pipe(
            Effect.annotateLogs({ projectId, cause }),
          );
        }),
      ),
    );

  const lastPrunedAtRef = yield* Ref.make(0);
  const pruneInboxIfDue = Effect.gen(function* () {
    const nowMs = Date.now();
    const lastPrunedAt = yield* Ref.get(lastPrunedAtRef);
    if (nowMs - lastPrunedAt < Duration.toMillis(INBOX_PRUNE_INTERVAL)) {
      return;
    }
    yield* Ref.set(lastPrunedAtRef, nowMs);
    yield* connectorRepository
      .pruneInbox({
        before: new Date(nowMs - Duration.toMillis(INBOX_RETENTION)).toISOString(),
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("telegram inbox prune failed").pipe(Effect.annotateLogs({ cause })),
        ),
      );
  });

  const pollCycle = Effect.gen(function* () {
    const records = yield* connectorRepository
      .listByKind("telegram")
      .pipe(Effect.orElseSucceed(() => []));
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
    yield* pruneInboxIfDue;
    // Poll all enabled bots concurrently; each long-polls up to 10s.
    yield* Effect.forEach(enabled, ({ projectId, config }) => pollConnector(projectId, config), {
      concurrency: 4,
      discard: true,
    });
  });

  // Proactive push (reminders/notifications): resolve the bot token from the
  // project's connector row and send. Every failure degrades to `false` +
  // a log line so a scheduler can decide delivered vs failed on its own.
  const sendText: ManagerTelegramServiceShape["sendText"] = (input) =>
    Effect.gen(function* () {
      const record = yield* connectorRepository
        .get({ projectId: input.projectId, kind: "telegram" })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(record)) {
        yield* Effect.logWarning("telegram push skipped: no connector").pipe(
          Effect.annotateLogs({ projectId: input.projectId, chatId: input.chatId }),
        );
        return false;
      }
      const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(record.value.config);
      if (decoded._tag !== "Success") {
        yield* Effect.logWarning("telegram push skipped: invalid connector config").pipe(
          Effect.annotateLogs({ projectId: input.projectId }),
        );
        return false;
      }
      if (!decoded.value.enabled) {
        yield* Effect.logWarning("telegram push skipped: connector disabled").pipe(
          Effect.annotateLogs({ projectId: input.projectId }),
        );
        return false;
      }
      return yield* sendTelegramText(
        input.projectId,
        decoded.value.botToken,
        input.chatId,
        input.text.slice(0, TELEGRAM_MESSAGE_LIMIT),
      ).pipe(Effect.map((resp) => resp.ok));
    });

  yield* Effect.forkScoped(Effect.forever(pollCycle));

  const getRuntimeStatus: ManagerTelegramServiceShape["getRuntimeStatus"] = (projectId) =>
    Effect.gen(function* () {
      const runtime = yield* getRuntime(projectId);
      const state = yield* connectorRepository
        .getState(connectorKey(projectId))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      return {
        botUsername: runtime.botUsername,
        lastError: runtime.lastError,
        health: healthFromState(state),
      };
    });

  const startPairing: ManagerTelegramServiceShape["startPairing"] = (projectId) =>
    Effect.gen(function* () {
      const pairing = newTelegramPairing(Date.now());
      const record = yield* connectorRepository
        .get({ projectId, kind: "telegram" })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const decoded = Option.isSome(record)
        ? Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(record.value.config)
        : null;
      const botToken =
        decoded !== null && decoded._tag === "Success" ? decoded.value.botToken : null;
      if (botToken !== null && isRelayCredential(botToken)) {
        const answer = yield* Effect.promise(() =>
          callTelegramBotMethod(botToken, "unoRegisterStartCode", {
            code: pairing.code,
            expires_in: Math.floor(TELEGRAM_PAIRING_TTL_MS / 1000),
          }),
        );
        if (!answer.ok) {
          yield* Effect.logWarning("telegram relay start code registration failed").pipe(
            Effect.annotateLogs({ projectId, description: answer.description }),
          );
          return yield* new TelegramPairingError({
            message: answer.description ?? "The console did not accept the link code.",
          });
        }
      }
      yield* Ref.update(pairingsRef, (map) => new Map(map).set(projectId, pairing));
      const runtime = yield* getRuntime(projectId);
      return {
        code: pairing.code,
        expiresAt: new Date(pairing.expiresAtMs).toISOString(),
        botUsername: runtime.botUsername,
      };
    });

  const sendTestMessage: ManagerTelegramServiceShape["sendTestMessage"] = (input) =>
    Effect.gen(function* () {
      const record = yield* connectorRepository
        .get({ projectId: input.projectId, kind: "telegram" })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(record)) return [];
      const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(record.value.config);
      if (decoded._tag !== "Success") return [];
      const config = decoded.value;
      return yield* Effect.forEach(
        config.allowedChatIds,
        (chatId) =>
          sendTelegramText(input.projectId, config.botToken, chatId, input.text).pipe(
            Effect.map((result) => ({
              chatId,
              ok: result.ok,
              error: result.ok ? null : (result.description ?? "Telegram refused the message."),
            })),
          ),
        { concurrency: 2 },
      );
    });

  return {
    getRuntimeStatus,
    sendText,
    startPairing,
    sendTestMessage,
  } satisfies ManagerTelegramServiceShape;
});

export const ManagerTelegramServiceLive = Layer.effect(
  ManagerTelegramService,
  makeTelegramConnector,
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
