/**
 * TelegramConnector - Telegram ingress/egress for assistants.
 *
 * Every assistant project may own its own bot: the poller iterates all
 * configured `telegram` connector rows each cycle, long-polls each bot, and
 * routes messages from allowlisted chats into that assistant's chat threads.
 * Incoming media is downloaded: images enter the chat attachment pipeline
 * (vision), voice/video/documents are saved to disk and described to the
 * harness by absolute path. Every addressed message becomes a pending reply
 * (`connectorReplies.ts`, on disk): its turn's final answer goes back to the
 * chat as a reply to that very message — however long the turn runs, across
 * daemon restarts — with "typing…" meanwhile; files the assistant marked with
 * `[[send-file: /abs/path]]` are uploaded after the text.
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
import { findMarkedAssistantChat } from "@t3tools/shared/assistantChat";
import {
  ApprovalRequestId,
  ASSISTANT_PROJECT_ID,
  CommandId,
  ManagerTelegramConnectorConfig,
  type ManagerTelegramGroupMembers,
  type ManagerTelegramGroupsResult,
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
import { Clock, Context, Data, Duration, Effect, Layer, Option, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  isGatingSpeechMedia,
  mediaToText,
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
import { processInboxEvents, recoverPendingEvents } from "../connectorInbox.ts";
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
  assistantAccessDepsOption,
  readAssistantRuntimeMode,
} from "../../assistants/assistantAccess.ts";
import {
  bindingOnConnector,
  decideThreadRouting,
  isPrivateTelegramChat,
  isPrivateTelegramChatId,
  mergeRoutedAccess,
  resolveChatTarget,
  routesToMainConversation,
  type RoutingThreadShell,
} from "../connectorBindings.ts";
import { migratePersonalTelegramChats } from "../telegramPersonalChats.ts";
import {
  decodeGroupDirectory,
  EMPTY_GROUP_DIRECTORY,
  recordGroupSender,
  TELEGRAM_GROUPS_FILE,
  telegramGroupAccess,
  telegramGroupsView,
  telegramPersonName,
  withTelegramGroupAccess,
  type TelegramGroupDirectory,
} from "../telegramGroups.ts";
import { OutsideThreads } from "../../automations/outsideThreads.ts";
import { executeConnectorCommand } from "../connectorCommandHandler.ts";
import { currentAssistantModelSelection } from "../assistantEngineSelection.ts";
import { parseConnectorCommand } from "../connectorCommands.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ManagerConnectorPendingReplyRepositoryLive } from "../../persistence/Layers/ManagerConnectorPendingReplies.ts";
import {
  makeConnectorReplies,
  readMeta,
  TYPING_RENEW_MS,
  type EnqueueOutcome,
  type SendOutcome,
  type SystemTurnInput,
} from "../connectorReplies.ts";
import { detectReplyLanguage, type ReplyLanguage } from "../connectorReplyText.ts";
import { fileRefusedText } from "../connectorReplies.ts";
import { UNO_WORK_OPEN_URL } from "../taskDoneNotify.ts";
import { currentWorkAddress } from "../../workAddress.ts";
import {
  buildMediaFailureNote,
  buildMediaNote,
  checkIncomingFile,
  collectMessageFiles,
  describeForwardOrigin,
  incomingFileNote,
  telegramAlbumKey,
  telegramUploadDir,
  wrapForwardedText,
  describeNonFileContent,
  isImageLikeMedia,
  pickTelegramUploadMethod,
  toNormalizedMessage,
  mediaLimitReply,
  TELEGRAM_BOT_UPLOAD_LIMIT_BYTES,
  TELEGRAM_PHOTO_UPLOAD_LIMIT_BYTES,
  TELEGRAM_SEND_FILE_HINT,
  type TelegramIncomingMessage,
  type TelegramMediaDescriptor,
} from "../telegramMedia.ts";
import {
  markdownLinksAsText,
  renderTelegramHtml,
  telegramTextFields,
} from "../telegramMarkdown.ts";
import {
  matchesTelegramPairing,
  newTelegramPairing,
  parseTelegramStartPayload,
  shouldReplyToStranger,
  TELEGRAM_PAIRING_TTL_MS,
  telegramLinkedReply,
  telegramRoutedLinkedReply,
  telegramStrangerReply,
  type TelegramPairing,
} from "../telegramPairing.ts";
import {
  classifyTelegramSender,
  type ConnectorSenderRole,
  telegramOwnerUserIds,
  withOwnerUserId,
} from "../connectorSenders.ts";
import {
  callTelegramBotMethod,
  isAssistantBotRelay,
  isRelayCredential,
  isRouteCredential,
  ownBotRelay,
  ownBotRelayTokens,
  parseRouteCredential,
  redactConnectorSecrets,
  RELAY_CREDENTIAL_PREFIX,
  telegramApiUrl,
  telegramFileUrl,
} from "../channelRelay.ts";
import * as OwnBotRelay from "../ownBotRelay.ts";
import { readWorkMachineIdentity } from "../workConsole.ts";
import { longPollSignal } from "../../economy/wakeSignal.ts";
import { BrowserBridge } from "../../browserBridge.ts";
import type { PersonCard } from "@t3tools/shared/personCard";
import { renderPersonCardWidget } from "@t3tools/shared/personCardWidget";
import {
  advanceQuiz,
  answerQuiz,
  cardButtons,
  cardPlainText,
  cardRichMarkdown,
  findQuizByPoll,
  idleQuizzes,
  newCardQuiz,
  nothingPickedToast,
  pickedMessage,
  putQuiz,
  quizIntroText,
  quizPollParams,
  quizSummaryText,
  removeQuiz,
  RICH_MESSAGE_MAX_MEDIA,
  RICH_MESSAGE_MAX_UPLOAD_BYTES,
  richMediaField,
  takeQuiz,
  type RichCardMedia,
} from "../telegramRichCard.ts";
import {
  admitAgentWidgetRequest,
  AGENT_WIDGET_OK,
  AGENT_WIDGET_SLOW,
  AGENT_WIDGET_TTL_MS,
  agentWidgetMessage,
  answerWidgetQuiz,
  decideWidgetPick,
  findAgentWidget,
  lastAgentWidget,
  parseWidgetRequest,
  putAgentWidget,
  spendWidgetGroup,
  WIDGET_CAPTION_MAX_CHARS,
  WIDGET_EXPIRED_STATE,
  widgetFits,
  widgetPickLabels,
  widgetQuizDoneState,
  widgetRequestPrefix,
  widgetSizeProblem,
  type AgentWidgetInput,
} from "../telegramWidgetCard.ts";
import {
  addButtonGroup,
  addSentMessageRoute,
  answeredElsewhereLine,
  buildInlineKeyboard,
  CHOICE_BUTTONS_TTL_MS,
  decideButtonPress,
  decodeButtonsState,
  EMPTY_BUTTONS_STATE,
  findReplyRoute,
  groupsForRequest,
  newButtonGroupId,
  parseCallbackData,
  pickedLabels,
  pickedValues,
  pressedLine,
  pressToastText,
  toggleGroupPick,
  pruneButtonsState,
  removeButtonGroup,
  requestGoneLine,
  setGroupMessageId,
  type ButtonGroup,
  type CardQuiz,
  type ConnectorButton,
  type ConnectorButtonsState,
} from "../connectorButtons.ts";

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
   * A message from a chat to the person: text, optionally a file (sent
   * natively, the text as its caption when it fits) and inline buttons.
   * `routeReplies`: the person's reply to it goes to `threadId`
   * (connectorButtons.ts). The file path must already be checked
   * (connectorOutgoingFiles.ts). Never fails.
   */
  readonly sendRich: (input: TelegramRichMessage) => Effect.Effect<{
    readonly ok: boolean;
    readonly error: string | null;
    /** With `widget`: whether it went as the widget or as the text. */
    readonly drawn?: "widget" | "text";
  }>;
  /**
   * A `show_card` card to the person: in a private chat first as a widget
   * (telegramWidgetCard.ts); else, or refused, a choice or a report as a
   * Rich Message with our buttons, a quiz as quiz polls (telegramRichCard.ts);
   * where Telegram (or the relay) refuses that, the old message with buttons.
   * `drawn` says what went. Never fails.
   */
  readonly sendCard: (input: TelegramCardMessage) => Effect.Effect<{
    readonly ok: boolean;
    readonly error: string | null;
    readonly drawn: "widget" | "rich" | "poll" | "text" | "none";
  }>;
  /**
   * `messenger_send` `widget_update`: the new `chat_data` of the last widget
   * the chat `threadId` sent to this Telegram chat. `error` is for the agent.
   */
  readonly updateWidget: (input: {
    readonly projectId: ProjectId;
    readonly chatId: string;
    readonly threadId: ThreadId;
    readonly state: string;
  }) => Effect.Effect<{ readonly ok: boolean; readonly error: string | null }>;
  /**
   * An approval request was answered (in the app, with /approve, by a
   * timeout): its buttons in Telegram go, the message says so.
   */
  readonly retireRequestButtons: (requestId: string) => Effect.Effect<void>;
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
  /**
   * A turn the daemon starts in a chat's conversation (the assistant's work
   * update, `assistantPush.ts`): queued and answered like a message of that
   * chat (`connectorReplies.ts`). Never fails: `failed` when it could not be
   * queued.
   */
  readonly enqueueSystemTurn: (input: SystemTurnInput) => Effect.Effect<EnqueueOutcome | "failed">;
  /**
   * The groups this assistant's bot answers in, who is heard in each, the
   * people seen writing there, and groups the owner wrote in that are not
   * added yet (`telegramGroups.ts`). Never fails: no bot → nothing.
   */
  readonly groups: (projectId: ProjectId) => Effect.Effect<ManagerTelegramGroupsResult>;
  /**
   * Set who is heard in one group (adds the group when it is not added yet).
   * `error` is a sentence for the person.
   */
  readonly setGroupAccess: (input: {
    readonly projectId: ProjectId;
    readonly chatId: string;
    readonly members: ManagerTelegramGroupMembers;
    readonly userIds?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<
    | { readonly ok: true; readonly result: ManagerTelegramGroupsResult }
    | { readonly ok: false; readonly error: string }
  >;
}

export class ManagerTelegramService extends Context.Service<
  ManagerTelegramService,
  ManagerTelegramServiceShape
>()("t3/manager/Services/ManagerTelegramService") {}

/** A name a stranger chose, safe inside a bracketed line of the turn's text. */
const plainForLine = (value: string): string =>
  value
    .replace(/[[\]"\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

const POLL_TIMEOUT_SECONDS = 10;
const IDLE_RECHECK = Duration.seconds(5);
// Persist `last_ok_at` on a healthy connector at most this often: the fact
// that it is still fine does not need a write per 10-second long poll.
const OK_PERSIST_INTERVAL = Duration.minutes(1);
// Terminal inbox rows older than this are pruned; the dedupe window only has
// to outlive Telegram's own retention of unconfirmed updates (24h).
const INBOX_RETENTION = Duration.days(7);
const INBOX_PRUNE_INTERVAL = Duration.hours(1);
const TELEGRAM_MESSAGE_LIMIT = 4000;
// Telegram takes 1024 characters of caption; the HTML rendering adds a few.
const TELEGRAM_CAPTION_LIMIT = 900;

// The handoff preamble (carrying recent history of the old thread into the
// replacement thread) is shared with "Continue on <machine>"; see
// `orchestration/handoff.ts`. Re-exported for the connector tests.
export { stripHandoffPreamble };

/**
 * What a failed send means for a pending reply: a refusal of the chat itself
 * (bot blocked, chat gone, bad request) will not change, anything else
 * (network, 429, 5xx, a token being swapped) may pass.
 */
export const telegramSendOutcome = (errorCode: number | undefined): SendOutcome =>
  errorCode === 400 || errorCode === 403 ? "gone" : "retry";

/** How long the first part of an album waits for the rest (they arrive within ~1 s). */
export const TELEGRAM_ALBUM_GATHER_MS = 1_500;

export interface TelegramRichMessage {
  /** The connector row (a routed row sends through its holder's bot). */
  readonly projectId: ProjectId;
  readonly chatId: string;
  readonly text: string;
  /** An absolute path already checked against the chat's sendable roots. */
  readonly filePath?: string | null;
  readonly buttons?: ReadonlyArray<ReadonlyArray<ConnectorButton>> | null;
  /** The chat the message speaks for: buttons and replies go back there. */
  readonly threadId: ThreadId;
  /** The person's reply to this message goes to `threadId`. */
  readonly routeReplies?: boolean;
  /** Approval buttons live shorter than a choice. */
  readonly buttonsTtlMs?: number;
  readonly language?: "ru" | "en";
  /**
   * `messenger_send` `rich`: the agent's own Rich Message (Markdown or HTML,
   * Bot API `InputRichMessage`), the buttons under it; `text` is what goes
   * where a Rich Message is refused.
   */
  readonly rich?: { readonly markdown?: string; readonly html?: string } | null;
  /**
   * `messenger_send` `widget`: the agent's own widget (Bot API 10.4), only in
   * a private chat; `text` goes where it is refused. `caption` is what old
   * apps show (the header included), `title` names its messages.
   */
  readonly widget?: (AgentWidgetInput & { readonly title: string }) | null;
}

export interface TelegramCardMessage {
  readonly projectId: ProjectId;
  readonly chatId: string;
  readonly threadId: ThreadId;
  readonly card: PersonCard;
  /** "💬 <chat>" for a work chat; null for the assistant itself. */
  readonly header: string | null;
  /** The report's pictures and files, absolute, checked against the sendable roots. */
  readonly images?: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<string>;
  readonly routeReplies?: boolean;
  readonly language?: "ru" | "en";
}

/** A press of an inline button (`allowed_updates` includes it). */
export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from?: TelegramIncomingMessage["from"];
  /** The message with the buttons (absent for inline-mode messages: never ours). */
  readonly message?: TelegramIncomingMessage;
  readonly data?: string;
}

/** An answer to one of our quiz polls (they are non-anonymous). */
export interface TelegramPollAnswer {
  readonly poll_id: string;
  readonly user?: { readonly id: number; readonly is_bot?: boolean };
  readonly option_ids?: ReadonlyArray<number>;
}

/**
 * A request of one of our widgets (`TelegramWidget.request`, Bot API 10.4).
 * It must be answered (`answerWidgetQuery`) within 15 seconds.
 */
export interface TelegramWidgetQuery {
  readonly id: string;
  readonly from?: TelegramIncomingMessage["from"];
  readonly chat?: TelegramIncomingMessage["chat"];
  readonly message_id?: number;
  readonly inline_message_id?: string;
  /** `{type: "data"}` for a plain request; wallet requests are not ours. */
  readonly type?: { readonly type?: string };
  /** 1–64 bytes. */
  readonly data?: string;
}

/** Updates the poller asks for: messages, presses of our buttons, answers to our quizzes and widgets. */
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "poll_answer",
  "widget_query",
] as const;

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramIncomingMessage;
  readonly callback_query?: TelegramCallbackQuery;
  readonly poll_answer?: TelegramPollAnswer;
  readonly widget_query?: TelegramWidgetQuery;
  /**
   * Set by Uno's assistant bot relay (`tga_`) on a `/start <code>` the
   * console already answered ("Connected to …"): link locally, say nothing.
   */
  readonly uno_linked?: boolean;
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
  /**
   * `credentialFingerprint` the runtime (and the persisted offset) belong to.
   * An own bot that switches between api.telegram.org and the console relay
   * keeps its token but changes stream — and this — so the runtime is rebuilt.
   */
  fingerprint: string | null;
  /** In-memory mirror of the persisted `getUpdates` offset. */
  offset: number;
  botUsername: string | null;
  lastError: string | null;
  health: ConnectorHealthRuntime;
  lastOkPersistedAtMs: number;
}

const INITIAL_BOT_RUNTIME: BotRuntime = {
  botToken: null,
  fingerprint: null,
  offset: 0,
  botUsername: null,
  lastError: null,
  health: INITIAL_CONNECTOR_HEALTH,
  lastOkPersistedAtMs: 0,
};

// Own bot → api.telegram.org, or the console's Bot-API mirror once the own
// bot is registered there (ownBotRelay.ts); `unorelay:<tgr>` → the mirror
// (channelRelay.ts). Every Bot-API URL of this connector goes here.
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

/** `message_id` of a `send*` result (a Message), or null. */
const sentMessageId = (result: unknown): number | null => {
  const id =
    typeof result === "object" && result !== null
      ? (result as { readonly message_id?: unknown }).message_id
      : undefined;
  return typeof id === "number" ? id : null;
};

/** Telegram refused our HTML: the same text goes again as plain text. */
const isTelegramParseError = (description: string | undefined): boolean =>
  description !== undefined && /parse entities|can't find end/i.test(description);

/**
 * Identity of the update stream the persisted offset belongs to. A relay
 * token rotates (every "Connect with Uno's bot" mints a new one) while the
 * relay queue — and its update ids — stays the same, so all relay tokens
 * share one fingerprint: rotation must not replay or drop the queue.
 *
 * An own bot has two streams: Telegram's own (update ids of the bot) and the
 * console relay's queue (row ids) once it goes through Uno. A Telegram offset
 * must never ack the queue and back, so the relay stream has its own
 * fingerprint — stable across relay-token rotations and restarts.
 */
export const credentialFingerprint = (botToken: string): string =>
  crypto
    .createHash("sha256")
    .update(
      isRelayCredential(botToken)
        ? RELAY_CREDENTIAL_PREFIX
        : ownBotRelay(botToken) !== null
          ? ownRelayStreamKey(botToken)
          : botToken,
    )
    .digest("hex")
    .slice(0, 16);

const ownRelayStreamKey = (botToken: string): string => `unoown:${botToken}`;

/** The fingerprint an own bot's state carries while it goes through the console. */
export const ownRelayFingerprint = (botToken: string): string =>
  crypto.createHash("sha256").update(ownRelayStreamKey(botToken)).digest("hex").slice(0, 16);

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
  const serverConfig = yield* ServerConfig;
  const accessDeps = yield* assistantAccessDepsOption;
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
  // Albums being gathered: parts by `<connector>:<chat>:<media_group_id>`.
  const albumsRef = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<TelegramUpdate>>>(new Map());
  // handleUpdate for a gathered album (set right after it is defined).
  const albumHandler: {
    run?: (
      projectId: ProjectId,
      config: ManagerTelegramConnectorConfig,
      lead: TelegramUpdate,
      rest: ReadonlyArray<TelegramIncomingMessage>,
    ) => Effect.Effect<void>;
  } = {};

  // Chats of group members the owner let in hold strangers' text: their
  // `uno-work` tools ask first (`automations/outsideThreads.ts`).
  const outsideThreads = Option.getOrNull(yield* Effect.serviceOption(OutsideThreads));

  // Groups and the people seen writing in them (telegramGroups.ts): what the
  // settings page offers to pick from. In memory, mirrored to disk.
  const groupsFile = nodePath.join(serverConfig.stateDir, TELEGRAM_GROUPS_FILE);
  const groupsRef = yield* Ref.make<TelegramGroupDirectory>(
    yield* Effect.promise(() =>
      fsPromises
        .readFile(groupsFile, "utf8")
        .then((raw) => decodeGroupDirectory(JSON.parse(raw)))
        .catch(() => EMPTY_GROUP_DIRECTORY),
    ),
  );
  const groupsWriteLock = yield* Semaphore.make(1);
  const updateGroups = (change: (state: TelegramGroupDirectory) => TelegramGroupDirectory) =>
    groupsWriteLock.withPermits(1)(
      Effect.gen(function* () {
        const before = yield* Ref.get(groupsRef);
        const next = change(before);
        if (next === before) return;
        yield* Ref.set(groupsRef, next);
        yield* Effect.promise(async () => {
          const temp = `${groupsFile}.${process.pid}.tmp`;
          await fsPromises.mkdir(nodePath.dirname(groupsFile), { recursive: true });
          await fsPromises.writeFile(temp, JSON.stringify(next), { mode: 0o600 });
          await fsPromises.rename(temp, groupsFile);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("telegram groups directory not saved").pipe(
              Effect.annotateLogs({ cause }),
            ),
          ),
        );
      }),
    );

  // Inline buttons and reply routes of messages chats sent to the person
  // (connectorButtons.ts): in memory, mirrored to disk so a restart (an
  // update) keeps them working.
  const buttonsFile = nodePath.join(serverConfig.stateDir, "connector-buttons.json");
  const buttonsRef = yield* Ref.make<ConnectorButtonsState>(
    yield* Effect.promise(() =>
      fsPromises
        .readFile(buttonsFile, "utf8")
        .then((raw) => pruneButtonsState(decodeButtonsState(JSON.parse(raw)), Date.now()))
        .catch(() => EMPTY_BUTTONS_STATE),
    ),
  );
  // Writes are serialized: two quick changes never race on the file.
  const buttonsWriteLock = yield* Semaphore.make(1);
  const updateButtons = (change: (state: ConnectorButtonsState) => ConnectorButtonsState) =>
    buttonsWriteLock.withPermits(1)(
      Effect.gen(function* () {
        const next = yield* Ref.updateAndGet(buttonsRef, change);
        yield* Effect.promise(async () => {
          const temp = `${buttonsFile}.${process.pid}.tmp`;
          await fsPromises.mkdir(nodePath.dirname(buttonsFile), { recursive: true });
          await fsPromises.writeFile(temp, JSON.stringify(next), { mode: 0o600 });
          await fsPromises.rename(temp, buttonsFile);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("telegram buttons state not saved").pipe(
              Effect.annotateLogs({ cause }),
            ),
          ),
        );
        return next;
      }),
    );
  // Uno Work tool approvals (the card) are answered through the bridge.
  const browserBridge = Option.getOrNull(yield* Effect.serviceOption(BrowserBridge));

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

  const decodeRow = (config: unknown): ManagerTelegramConnectorConfig | null => {
    const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(config);
    return decoded._tag === "Success" ? decoded.value : null;
  };

  /** Every stored Telegram row that decodes. */
  const listRows = connectorRepository.listByKind("telegram").pipe(
    Effect.map((records) =>
      records.flatMap((record) => {
        const config = decodeRow(record.config);
        return config === null ? [] : [{ projectId: record.projectId, config }];
      }),
    ),
    Effect.orElseSucceed(
      (): ReadonlyArray<{
        readonly projectId: ProjectId;
        readonly config: ManagerTelegramConnectorConfig;
      }> => [],
    ),
  );

  const readRow = (projectId: ProjectId) =>
    connectorRepository.get({ projectId, kind: "telegram" }).pipe(
      Effect.map((row) => (Option.isSome(row) ? decodeRow(row.value.config) : null)),
      Effect.orElseSucceed(() => null),
    );

  /**
   * Rows of other assistants of this computer that talk through `holder`'s
   * bot (`unoroute:<holder>`, see `channelRelay.ts`).
   */
  const routedRowsOf = (holder: ProjectId) =>
    listRows.pipe(
      Effect.map((rows) =>
        rows.filter((row) => parseRouteCredential(row.config.botToken) === holder),
      ),
    );

  /**
   * The bot a row actually talks through: its own token, or — for a routed
   * row — its holder's. Null when the holder is gone or no longer holds a bot.
   */
  const resolveSendRow = (projectId: ProjectId, config: ManagerTelegramConnectorConfig) =>
    Effect.gen(function* () {
      const holder = parseRouteCredential(config.botToken);
      if (holder === null) return { projectId, botToken: config.botToken };
      const holderConfig = yield* readRow(ProjectId.make(holder));
      if (holderConfig === null || parseRouteCredential(holderConfig.botToken) !== null) {
        return null;
      }
      return { projectId: ProjectId.make(holder), botToken: holderConfig.botToken };
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

  // The main conversation ("Uno"), when it exists and is not archived.
  const findLiveMainConversationId = projectionSnapshotQuery.getShellSnapshot().pipe(
    Effect.map((snapshot) => {
      const main = findMarkedAssistantChat(snapshot.threads);
      return main !== null && main.archivedAt === null ? main.id : null;
    }),
    Effect.orElseSucceed(() => null),
  );

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
    readonly senderRole: Exclude<ConnectorSenderRole, "ignore">;
  }) =>
    Effect.gen(function* () {
      const { target } = input;
      // Group members the owner let in get a thread of their own, pinned to
      // approval-required: they never share (or widen) the owner's thread.
      const forcedRuntimeMode = input.senderRole === "member" ? "approval-required" : null;
      const mappingChatId =
        input.senderRole === "member" ? `${input.chatId}:members` : input.chatId;
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
            forcedRuntimeMode,
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
          chatId: mappingChatId,
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
          forcedRuntimeMode,
          // "Cautious" holds for the harness itself: its chats run narrower.
          assistantRuntimeMode:
            target.kind === "assistant" && accessDeps !== null
              ? yield* readAssistantRuntimeMode(accessDeps, target.projectId)
              : null,
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
              title:
                input.senderRole === "member"
                  ? `Telegram: ${input.chatLabel} (members)`
                  : `Telegram: ${input.chatLabel}`,
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
            chatId: mappingChatId,
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
        (descriptor) => isGatingSpeechMedia(descriptor) && mediaLimitReply(descriptor) === null,
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
  // `replyTo` quotes the person's message (deleted meanwhile: sent without
  // the quote); HTML Telegram cannot parse goes again as plain text.
  const sendTelegramText = (
    projectId: ProjectId,
    botToken: string,
    chatId: string,
    text: string,
    options: { readonly replyTo?: string | null; readonly replyMarkup?: unknown } = {},
  ): Effect.Effect<{
    readonly ok: boolean;
    readonly description?: string;
    readonly errorCode?: number | undefined;
    /** The sent message's id (reply routing, buttons). */
    readonly messageId?: number | null;
  }> => {
    const replyTo = options.replyTo ?? null;
    const attempt = (html: boolean) =>
      attemptWithBackoff(
        fetchJson(telegramApi(botToken, "sendMessage"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            ...telegramTextFields(text, html),
            ...(replyTo !== null && /^\d+$/.test(replyTo)
              ? {
                  reply_parameters: {
                    message_id: Number(replyTo),
                    allow_sending_without_reply: true,
                  },
                }
              : {}),
            ...(options.replyMarkup !== undefined ? { reply_markup: options.replyMarkup } : {}),
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
      );
    return attempt(true).pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "TelegramApiRejection" &&
          error.errorCode === 400 &&
          /parse entities|can't find end/i.test(error.description),
        () => attempt(false),
      ),
      Effect.tap(() => recordDelivery(projectId, true, null)),
      Effect.map((response) => ({ ok: true as const, messageId: sentMessageId(response.result) })),
      Effect.catch((error) => {
        const description =
          error._tag === "TelegramApiRejection" ? error.description : error.message;
        const errorCode = error._tag === "TelegramApiRejection" ? error.errorCode : undefined;
        return Effect.logWarning("telegram sendMessage failed after retries").pipe(
          Effect.annotateLogs({ projectId, chatId, description }),
          Effect.andThen(recordDelivery(projectId, false, description)),
          Effect.as({ ok: false as const, description, errorCode }),
        );
      }),
    );
  };

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

  // Store image bytes as a chat attachment (harnesses see it as a vision
  // input). Null when it does not fit or cannot be written: the caller falls
  // back to a saved file.
  const storeImageAttachment = (input: {
    readonly threadId: ThreadId;
    readonly chatId: string;
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): Effect.Effect<ChatImageAttachment | null> =>
    Effect.gen(function* () {
      if (
        input.bytes.byteLength === 0 ||
        input.bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      ) {
        return null;
      }
      const attachmentId = createAttachmentId(input.threadId);
      if (attachmentId === null) return null;
      const attachment = {
        type: "image" as const,
        id: attachmentId,
        name: input.name,
        mimeType: input.mimeType.toLowerCase(),
        sizeBytes: input.bytes.byteLength,
      } satisfies ChatImageAttachment;
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (attachmentPath === null) return null;
      const stored = yield* Effect.tryPromise({
        try: async () => {
          await fsPromises.mkdir(nodePath.dirname(attachmentPath), { recursive: true });
          await fsPromises.writeFile(attachmentPath, input.bytes);
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
      return stored ? attachment : null;
    });

  // Download every media payload of an incoming message. Images become chat
  // attachments (the harness sees them as vision inputs); everything else is
  // saved under `~/Uploads/YYYY-MM/telegram/` (read-only for the owner, never
  // run) and described as one line: who sent what, its real type by content,
  // its size and path, flagged when it is a program or not what its name
  // says. Voice notes stay under `telegram-files/<chatId>/`. Failures degrade
  // to notes too — the turn still runs so the user gets an answer.
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
    /** Who sent it, as the note names them ("Misha"). */
    readonly sender?: string;
    /** The files came from the message the person replied to. */
    readonly fromReply?: boolean;
  }) =>
    Effect.gen(function* () {
      const attachments: Array<ChatImageAttachment> = [];
      const notes: Array<string> = [];
      for (const descriptor of input.media) {
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
          attachments.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS
        ) {
          const attachment = yield* storeImageAttachment({
            threadId: input.threadId,
            chatId: input.chatId,
            name: descriptor.fileName,
            mimeType: descriptor.mimeType,
            bytes,
          });
          if (attachment !== null) {
            attachments.push(attachment);
            continue;
          }
        }

        // Voice notes stay in the server's own folder (they become text);
        // files the person sends land where they can find them.
        const directory =
          descriptor.kind === "voice" || descriptor.kind === "video_note"
            ? nodePath.join(telegramFilesDir, input.chatId)
            : telegramUploadDir(os.homedir(), new Date());
        const savedPath = nodePath.join(
          directory,
          `${crypto.randomUUID().slice(0, 8)}-${descriptor.fileName}`,
        );
        const saved = yield* Effect.tryPromise({
          try: async () => {
            await fsPromises.mkdir(directory, { recursive: true });
            // Kept, never run: no exec bits, owner only.
            await fsPromises.writeFile(savedPath, bytes, { mode: 0o600 });
            await fsPromises.chmod(savedPath, 0o600);
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

        // Голос и аудио — в текст через гейтвей, видео и кружки — описание
        // (речь + что на экране). Текст попадает в сообщение (виден в
        // диалоге приложения и любому харнессу); ошибка шлюза — пометка
        // «could not transcribe» и путь к файлу, ход всё равно идёт.
        const settings = yield* serverSettingsService.getSettings.pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const converted = yield* mediaToText({
          descriptor,
          bytes,
          savedPath,
          baseUrl: UNO_GATEWAY_BASE_URL,
          apiKey: settings?.uno.apiKey?.trim() ?? "",
          // Reuse the transcript computed during addressing gating, if any.
          precomputedTranscript: input.precomputedTranscripts?.get(descriptor.fileId) ?? null,
        });
        if (converted !== null) {
          notes.push(converted.text);
          if (
            converted.thumbnailFileId !== null &&
            attachments.length < PROVIDER_SEND_TURN_MAX_ATTACHMENTS
          ) {
            const thumbnailFileId = converted.thumbnailFileId;
            const frame = yield* downloadTelegramFile(input.botToken, thumbnailFileId).pipe(
              Effect.flatMap((frameBytes) =>
                storeImageAttachment({
                  threadId: input.threadId,
                  chatId: input.chatId,
                  name: "video-frame.jpg",
                  mimeType: "image/jpeg",
                  bytes: frameBytes,
                }),
              ),
              Effect.catch(() => Effect.succeed(null)),
            );
            if (frame !== null) {
              attachments.push(frame);
              notes.push(
                `[The attached image is a preview frame of this ${
                  descriptor.kind === "video_note" ? "video message" : "video"
                }.]`,
              );
            }
          }
          continue;
        }

        notes.push(
          descriptor.kind === "voice" || descriptor.kind === "video_note"
            ? buildMediaNote(descriptor, savedPath)
            : incomingFileNote({
                sender: input.sender ?? "the person",
                descriptor,
                savedPath,
                sizeBytes: bytes.length,
                check: checkIncomingFile(descriptor.fileName, bytes),
                ...(input.fromReply === true ? { fromRepliedMessage: true } : {}),
              }),
        );
      }
      return { attachments, notes };
    });

  // Upload a file the assistant marked with `[[send-file: …]]` or queued with
  // send_file. Photos, voice, audio, video and GIFs go natively
  // (pickTelegramUploadMethod), with a sendDocument fallback when Telegram
  // refuses (a photo over its dimension limits, a voice note not in Opus);
  // everything else via sendDocument. Failures are reported
  // into the chat so the user isn't left waiting for a file that never comes.
  const sendTelegramFile = (
    projectId: ProjectId,
    botToken: string,
    chatId: string,
    filePath: string,
    options: {
      readonly caption?: string;
      readonly replyMarkup?: unknown;
      readonly language?: ReplyLanguage;
    } = {},
  ) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.tryPromise({
        try: async () => {
          const stat = await fsPromises.stat(filePath);
          if (!stat.isFile()) {
            throw new Error("not a regular file");
          }
          if (stat.size > TELEGRAM_BOT_UPLOAD_LIMIT_BYTES) {
            throw new Error(
              `it is ${Math.round(stat.size / 1024 / 1024)} MB, over the 50 MB a Telegram bot may send — ask for a link instead`,
            );
          }
          const bytes = await fsPromises.readFile(filePath);
          const fileName = nodePath.basename(filePath);
          const caption = options.caption?.trim() ?? "";
          interface UploadAnswer {
            readonly ok?: boolean;
            readonly description?: string;
            readonly result?: unknown;
          }
          const upload = async (
            method: string,
            field: string,
            html: boolean,
          ): Promise<UploadAnswer> => {
            const form = new FormData();
            form.append("chat_id", chatId);
            form.append(field, new Blob([new Uint8Array(bytes)]), fileName);
            if (caption.length > 0) {
              form.append(
                "caption",
                html ? renderTelegramHtml(caption) : markdownLinksAsText(caption),
              );
              if (html) form.append("parse_mode", "HTML");
            }
            if (options.replyMarkup !== undefined) {
              form.append("reply_markup", JSON.stringify(options.replyMarkup));
            }
            const response = await fetch(telegramApi(botToken, method), {
              method: "POST",
              body: form,
            });
            const answer = (await response.json()) as UploadAnswer;
            return answer.ok !== true && html && isTelegramParseError(answer.description)
              ? upload(method, field, false)
              : answer;
          };
          const preferred = pickTelegramUploadMethod(fileName, stat.size);
          let result = await upload(preferred.method, preferred.field, true);
          if (result.ok !== true && preferred.method !== "sendDocument") {
            result = await upload("sendDocument", "document", true);
          }
          if (result.ok !== true) {
            throw new Error(result.description ?? "upload rejected by Telegram");
          }
          return sentMessageId(result.result);
        },
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.map((messageId) => ({ ok: true as const, messageId, error: null })),
        Effect.catch((reason) =>
          Effect.succeed({
            ok: false as const,
            messageId: null,
            error: redactConnectorSecrets(reason),
          }),
        ),
      );
      if (!outcome.ok) {
        yield* Effect.logWarning("telegram file upload failed").pipe(
          Effect.annotateLogs({ chatId, filePath, description: outcome.error }),
        );
        yield* sendTelegramText(
          projectId,
          botToken,
          chatId,
          fileRefusedText(options.language ?? "en", nodePath.basename(filePath), outcome.error),
        );
      }
      return outcome;
    });

  // The bot a pending reply answers through: the connector that received
  // the message (its own token, or Uno's relay).
  const botTokenOf = (projectId: ProjectId) =>
    readRow(projectId).pipe(Effect.map((config) => config?.botToken ?? null));

  // Answers to chat messages: on disk, bound to each message's own turn,
  // no deadline (see `connectorReplies.ts`).
  // One "typing…" per chat however many of its messages wait.
  const typingAtRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const replies = yield* makeConnectorReplies({
    kind: "telegram",
    limit: TELEGRAM_MESSAGE_LIMIT,
    fileLimitBytes: TELEGRAM_BOT_UPLOAD_LIMIT_BYTES,
    logPrefix: "telegram",
    typing: (row) =>
      Effect.gen(function* () {
        const key = `${row.connectorProjectId}:${row.chatId}`;
        const nowMs = yield* Clock.currentTimeMillis;
        const last = (yield* Ref.get(typingAtRef)).get(key) ?? 0;
        if (nowMs - last < TYPING_RENEW_MS - 500) return;
        yield* Ref.update(typingAtRef, (map) => new Map(map).set(key, nowMs));
        const botToken = yield* botTokenOf(row.connectorProjectId);
        if (botToken !== null) yield* sendTelegramTypingAction(botToken, row.chatId);
      }),
    sendText: (row, text, { asReply }) =>
      Effect.gen(function* () {
        const botToken = yield* botTokenOf(row.connectorProjectId);
        if (botToken === null) return "retry";
        const result = yield* sendTelegramText(row.connectorProjectId, botToken, row.chatId, text, {
          replyTo: asReply ? row.replyTo : null,
        });
        return result.ok ? "ok" : telegramSendOutcome(result.errorCode);
      }),
    sendFile: (row, path) =>
      Effect.gen(function* () {
        const botToken = yield* botTokenOf(row.connectorProjectId);
        if (botToken === null) return "retry";
        yield* sendTelegramFile(row.connectorProjectId, botToken, row.chatId, path, {
          language: row.language,
        });
        return "ok";
      }),
    onSettled: (row, delivered) => {
      const hotKey = readMeta(row).hotKey;
      return delivered && typeof hotKey === "string" ? markHotWindow(hotKey) : Effect.void;
    },
  });

  // ── Inline buttons ────────────────────────────────────────────────────

  /**
   * A press (a button, "Done", the end of a quiz) answers the chat it
   * belongs to as the person's message — visible in the chat, answered
   * back in Telegram like anything they type.
   */
  const answerAsPerson = (input: {
    readonly projectId: ProjectId;
    readonly config: ManagerTelegramConnectorConfig;
    readonly chatId: string;
    readonly chatLabel: string;
    readonly threadId: string;
    readonly text: string;
    readonly replyKey: string;
    readonly replyTo: string | null;
    readonly language: ReplyLanguage;
  }) =>
    Effect.gen(function* () {
      const { threadId, runtimeMode, interactionMode } = yield* ensureThreadForChat({
        target: { kind: "thread", threadId: ThreadId.make(input.threadId) },
        chatId: input.chatId,
        chatLabel: input.chatLabel,
        config: input.config,
        senderRole: "owner",
      });
      yield* replies.enqueue({
        connectorProjectId: input.projectId,
        replyKey: input.replyKey,
        chatId: input.chatId,
        replyTo: input.replyTo,
        replyThread: null,
        threadId,
        language: input.language,
        dispatch: { text: input.text, attachments: [], runtimeMode, interactionMode },
        extraMeta: { hotKey: hotWindowKey(input.projectId, input.chatId) },
      });
      yield* Effect.logInfo("telegram button answered a chat").pipe(
        Effect.annotateLogs({ projectId: input.projectId, chatId: input.chatId, threadId }),
      );
    });

  const callBotJson = (botToken: string, method: string, body: Record<string, unknown>) =>
    fetchJson(telegramApi(botToken, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).pipe(Effect.orElseSucceed((): TelegramApiResponse => ({ ok: false })));

  const answerCallback = (botToken: string, callbackId: string, text?: string) =>
    callBotJson(botToken, "answerCallbackQuery", {
      callback_query_id: callbackId,
      ...(text !== undefined ? { text } : {}),
    }).pipe(Effect.asVoid);

  /**
   * The message of a spent group: its text with `line` under it, and no
   * buttons. A message whose text we don't have (or Telegram won't take)
   * at least loses its buttons.
   */
  const finishButtonMessage = (
    botToken: string,
    group: Pick<ButtonGroup, "chatId" | "messageId" | "text" | "caption" | "rich">,
    line: string,
  ) =>
    Effect.gen(function* () {
      if (group.messageId === null) return;
      const target = { chat_id: group.chatId, message_id: group.messageId };
      const removeKeyboard = { reply_markup: { inline_keyboard: [] } };
      if (group.rich === true) {
        // A Rich Message keeps its content (pictures, tables): only the
        // keyboard turns into the line, as a disabled button (Bot API 10.3).
        const answer = yield* callBotJson(botToken, "editMessageReplyMarkup", {
          ...target,
          reply_markup: { inline_keyboard: [[{ text: line.slice(0, 60), disabled: {} }]] },
        });
        if (answer.ok === true) return;
        yield* callBotJson(botToken, "editMessageReplyMarkup", { ...target, ...removeKeyboard });
        return;
      }
      if (group.text !== undefined) {
        const method = group.caption === true ? "editMessageCaption" : "editMessageText";
        const field = group.caption === true ? "caption" : "text";
        const body = `${group.text}\n\n${line}`.trim();
        let answer = yield* callBotJson(botToken, method, {
          ...target,
          [field]: renderTelegramHtml(body),
          parse_mode: "HTML",
          ...removeKeyboard,
        });
        if (answer.ok !== true && isTelegramParseError(answer.description)) {
          answer = yield* callBotJson(botToken, method, {
            ...target,
            [field]: body,
            ...removeKeyboard,
          });
        }
        if (answer.ok === true) return;
      }
      yield* callBotJson(botToken, "editMessageReplyMarkup", { ...target, ...removeKeyboard });
    });

  /**
   * A press of one of our buttons. Only the owner, in the chat the message
   * went to, through this bot; the group is spent before anything runs, so
   * a double tap does nothing twice.
   */
  const handleCallbackQuery = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    query: TelegramCallbackQuery,
  ) =>
    Effect.gen(function* () {
      const language = detectReplyLanguage("", query.from?.language_code);
      const message = query.message;
      const chatIdNumber = message?.chat?.id;
      if (parseCallbackData(query.data) === null) {
        // Not ours (another tool's keyboard): close the spinner, nothing else.
        yield* answerCallback(config.botToken, query.id);
        return;
      }
      if (message === undefined || chatIdNumber === undefined) {
        yield* answerCallback(config.botToken, query.id, pressToastText("unknown", language));
        return;
      }
      const chatId = String(chatIdNumber);
      const routedRows = yield* routedRowsOf(projectId);
      const access = mergeRoutedAccess(
        config,
        routedRows.map((row) => row.config),
      );
      const senderRole = access.allowedChatIds.includes(chatId)
        ? classifyTelegramSender({
            chat: message.chat,
            from: query.from,
            allowedChatIds: access.allowedChatIds,
            ownerUserIds: access.ownerUserIds,
            groupAccess: telegramGroupAccess(config, chatId),
          })
        : "ignore";
      const press = decideButtonPress({
        state: yield* Ref.get(buttonsRef),
        data: query.data,
        connectorProjectId: projectId,
        chatId,
        messageId: message.message_id,
        senderIsOwner: senderRole === "owner",
        nowMs: Date.now(),
      });
      if (press.kind !== "ok") {
        yield* answerCallback(config.botToken, query.id, pressToastText(press.kind, language));
        if (press.kind === "expired" && message.message_id !== undefined) {
          yield* callBotJson(config.botToken, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: message.message_id,
            reply_markup: { inline_keyboard: [] },
          });
        }
        yield* Effect.logInfo("telegram button press refused").pipe(
          Effect.annotateLogs({ projectId, chatId, reason: press.kind }),
        );
        return;
      }
      const { group, button } = press;
      if (button.action.kind === "toggle") {
        // A multiple choice: the option is picked or unpicked, the group lives on.
        const index = group.rows.flat().indexOf(button);
        const next = yield* updateButtons((state) => toggleGroupPick(state, group.id, index).state);
        const toggled = next.groups.find((entry) => entry.id === group.id) ?? null;
        yield* answerCallback(config.botToken, query.id);
        const messageId = group.messageId ?? message.message_id ?? null;
        if (toggled !== null && messageId !== null) {
          yield* callBotJson(config.botToken, "editMessageReplyMarkup", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: buildInlineKeyboard(toggled),
          });
        }
        return;
      }
      if (button.action.kind === "submit" && pickedValues(group) === null) {
        yield* answerCallback(
          config.botToken,
          query.id,
          nothingPickedToast(group.language ?? language),
        );
        return;
      }
      yield* updateButtons((state) => removeButtonGroup(state, group.id));
      const finish = (line: string) =>
        finishButtonMessage(
          config.botToken,
          { ...group, messageId: group.messageId ?? message.message_id ?? null },
          line,
        );
      const action = button.action;
      const answerChat = (text: string) =>
        answerAsPerson({
          projectId,
          config,
          chatId,
          chatLabel: message.chat?.title ?? message.chat?.username ?? chatId,
          threadId: group.threadId,
          text,
          replyKey: `${chatId}:cb:${query.id}`,
          replyTo: message.message_id === undefined ? null : String(message.message_id),
          language: group.language ?? language,
        });
      switch (action.kind) {
        case "submit": {
          yield* answerCallback(config.botToken, query.id);
          yield* finish(pressedLine(pickedLabels(group).join(", ")));
          yield* answerChat(pickedMessage(pickedValues(group) ?? [], group.language ?? language));
          return;
        }
        case "reply": {
          yield* answerCallback(config.botToken, query.id);
          yield* finish(pressedLine(button.label));
          yield* answerChat(action.value);
          return;
        }
        case "approval": {
          const threadId = ThreadId.make(group.threadId);
          const pending = yield* pendingApprovalRepository
            .listByThreadId({ threadId })
            .pipe(Effect.orElseSucceed(() => []));
          const open = pending.some(
            (row) => row.status === "pending" && row.requestId === action.requestId,
          );
          if (!open) {
            yield* answerCallback(config.botToken, query.id, requestGoneLine(language));
            yield* finish(answeredElsewhereLine(group.language ?? language));
            return;
          }
          yield* orchestrationEngine.dispatch(
            {
              type: "thread.approval.respond",
              commandId: CommandId.make(`telegram:${crypto.randomUUID()}`),
              threadId,
              requestId: ApprovalRequestId.make(action.requestId),
              decision: action.decision,
              createdAt: new Date().toISOString(),
            },
            { origin: telegramCommandOrigin(chatId) },
          );
          yield* answerCallback(config.botToken, query.id);
          yield* finish(pressedLine(button.label));
          yield* Effect.logInfo("telegram button resolved an approval").pipe(
            Effect.annotateLogs({ projectId, chatId, threadId, decision: action.decision }),
          );
          return;
        }
        case "tool-approval": {
          const answered =
            browserBridge === null
              ? false
              : yield* browserBridge.completeToolApprovalById({
                  requestId: action.requestId,
                  approved: action.approved,
                });
          if (!answered) {
            yield* answerCallback(config.botToken, query.id, requestGoneLine(language));
            yield* finish(answeredElsewhereLine(group.language ?? language));
            return;
          }
          yield* answerCallback(config.botToken, query.id);
          yield* finish(pressedLine(button.label));
          yield* Effect.logInfo("telegram button answered a Uno Work approval").pipe(
            Effect.annotateLogs({ projectId, chatId, approved: action.approved }),
          );
          return;
        }
      }
    }).pipe(
      // The chat it answers is gone: say so where the person pressed.
      Effect.catchTag("TelegramRoutingError", (error) => {
        const chatId = query.message?.chat?.id;
        return chatId === undefined
          ? Effect.void
          : sendTelegramText(projectId, config.botToken, String(chatId), error.message).pipe(
              Effect.asVoid,
            );
      }),
    );

  /** The chat a reply of the owner goes to: the one whose message they replied to. */
  const replyRouteOf = (projectId: ProjectId, chatId: string, message: TelegramIncomingMessage) =>
    Effect.gen(function* () {
      const replied = message.reply_to_message;
      if (replied?.message_id === undefined || replied.from?.is_bot !== true) return null;
      const threadId = findReplyRoute(yield* Ref.get(buttonsRef), {
        connectorProjectId: projectId,
        chatId,
        messageId: replied.message_id,
        nowMs: Date.now(),
      });
      return threadId === null ? null : ThreadId.make(threadId);
    });

  const sendRich: ManagerTelegramServiceShape["sendRich"] = (input) =>
    Effect.gen(function* () {
      const config = yield* readRow(input.projectId);
      if (config === null || !config.enabled) {
        return { ok: false, error: "Telegram is not connected." };
      }
      const via = yield* resolveSendRow(input.projectId, config);
      if (via === null) return { ok: false, error: "Telegram is not connected." };
      const nowMs = Date.now();
      const text = input.text.slice(0, TELEGRAM_MESSAGE_LIMIT);
      const filePath = input.filePath ?? null;
      const asCaption = filePath !== null && text.length <= TELEGRAM_CAPTION_LIMIT;
      const buttons = input.buttons ?? [];
      const group: ButtonGroup | null =
        buttons.length === 0
          ? null
          : {
              id: newButtonGroupId(),
              connectorProjectId: via.projectId,
              chatId: input.chatId,
              messageId: null,
              threadId: input.threadId,
              rows: buttons,
              text,
              ...(asCaption ? { caption: true } : {}),
              ...(input.language !== undefined ? { language: input.language } : {}),
              createdAtMs: nowMs,
              expiresAtMs: nowMs + (input.buttonsTtlMs ?? CHOICE_BUTTONS_TTL_MS),
            };
      if (group !== null) yield* updateButtons((state) => addButtonGroup(state, group, nowMs));
      const replyMarkup = group === null ? undefined : buildInlineKeyboard(group);
      const markup = replyMarkup === undefined ? {} : { replyMarkup };
      let sent: {
        readonly ok: boolean;
        readonly messageId: number | null;
        readonly error: string | null;
      };
      // The agent's own widget (a private chat only) or Rich Message first;
      // refused (an old relay, a markup Telegram won't take) → the plain
      // message below, as before.
      const widget = input.widget ?? null;
      let widgetNote: string | null = null;
      let widgetSent: {
        readonly ok: boolean;
        readonly messageId: number | null;
        readonly description: string | null;
      } | null = null;
      if (widget !== null && !isPrivateTelegramChatId(input.chatId)) {
        widgetNote =
          "Telegram shows widgets only in the private chat with the bot, not in groups: the text went instead.";
      } else if (widget !== null) {
        widgetSent = yield* sendWidgetRaw(via.botToken, input.chatId, {
          html: widget.html,
          caption: widget.caption ?? text,
          ...(widget.state !== undefined ? { chatData: widget.state } : {}),
          ...(widget.width !== undefined ? { width: widget.width } : {}),
          ...(widget.height !== undefined ? { height: widget.height } : {}),
          allowQueries: true,
          replyMarkup,
        });
        if (!widgetSent.ok) {
          widgetNote = `Telegram didn't show the widget (${widgetSent.description ?? "refused"}): the text went instead.`;
          yield* Effect.logInfo("telegram widget refused, sending plain text").pipe(
            Effect.annotateLogs({ chatId: input.chatId, description: widgetSent.description }),
          );
        }
      }
      const richSent =
        widgetSent?.ok !== true &&
        input.rich !== undefined &&
        input.rich !== null &&
        (input.rich.markdown !== undefined || input.rich.html !== undefined)
          ? yield* sendRichMessageRaw(via.botToken, input.chatId, input.rich, [], replyMarkup)
          : null;
      if (richSent !== null && !richSent.ok) {
        yield* Effect.logInfo("telegram rich message refused, sending plain text").pipe(
          Effect.annotateLogs({ chatId: input.chatId, description: richSent.description }),
        );
      }
      const shown = widgetSent?.ok === true ? widgetSent : richSent?.ok === true ? richSent : null;
      if (shown !== null) {
        yield* recordDelivery(via.projectId, true, null);
        if (group !== null) {
          yield* updateButtons((state) => ({
            ...state,
            groups: state.groups.map((entry) =>
              entry.id === group.id ? { ...entry, rich: true, caption: false } : entry,
            ),
          }));
        }
        if (widget !== null && shown === widgetSent && shown.messageId !== null) {
          const messageId = shown.messageId;
          yield* updateButtons((state) =>
            putAgentWidget(state, {
              connectorProjectId: via.projectId,
              chatId: input.chatId,
              messageId,
              threadId: input.threadId,
              title: widget.title,
              sentAtMs: nowMs,
              expiresAtMs: nowMs + AGENT_WIDGET_TTL_MS,
            }),
          );
        }
        sent = { ok: true, messageId: shown.messageId, error: null };
        if (filePath !== null) {
          const file = yield* sendTelegramFile(via.projectId, via.botToken, input.chatId, filePath);
          if (!file.ok) sent = { ...sent, error: file.error };
        }
      } else if (asCaption) {
        sent = yield* sendTelegramFile(via.projectId, via.botToken, input.chatId, filePath, {
          caption: text,
          ...markup,
        });
        // The file did not go (the chat was told why): the words still do.
        if (!sent.ok && (text.length > 0 || group !== null)) {
          const fallback = yield* sendTelegramText(
            via.projectId,
            via.botToken,
            input.chatId,
            text,
            markup,
          );
          if (fallback.ok) {
            if (group !== null) {
              yield* updateButtons((state) => ({
                ...state,
                groups: state.groups.map((entry) =>
                  entry.id === group.id ? { ...entry, caption: false } : entry,
                ),
              }));
            }
            sent = { ok: true, messageId: fallback.messageId ?? null, error: sent.error };
          }
        }
      } else {
        const result = yield* sendTelegramText(
          via.projectId,
          via.botToken,
          input.chatId,
          text,
          markup,
        );
        sent = {
          ok: result.ok,
          messageId: result.messageId ?? null,
          error: result.ok ? null : (result.description ?? "Telegram refused the message."),
        };
        if (result.ok && filePath !== null) {
          const file = yield* sendTelegramFile(via.projectId, via.botToken, input.chatId, filePath);
          if (!file.ok) sent = { ...sent, error: file.error };
        }
      }
      if (!sent.ok) {
        if (group !== null) yield* updateButtons((state) => removeButtonGroup(state, group.id));
        return { ok: false, error: sent.error ?? "Telegram refused the message." };
      }
      const messageId = sent.messageId;
      if (messageId !== null) {
        yield* updateButtons((state) => {
          const withId = group === null ? state : setGroupMessageId(state, group.id, messageId);
          return input.routeReplies === true
            ? addSentMessageRoute(
                withId,
                {
                  connectorProjectId: via.projectId,
                  chatId: input.chatId,
                  messageId,
                  threadId: input.threadId,
                  atMs: nowMs,
                },
                nowMs,
              )
            : withId;
        });
      }
      return {
        ok: true,
        error: sent.error ?? widgetNote,
        ...(widget !== null ? { drawn: widgetSent?.ok === true ? "widget" : "text" } : {}),
      } as const;
    });

  /**
   * `sendRichMessage` (Bot API 10.1): `rich_message` = InputRichMessage
   * (exactly one of markdown / html), local files uploaded in the same
   * multipart request as `attach://<id>` (InputRichMessageMedia, 10.2).
   * One attempt: a refusal falls back to the old message at the caller.
   */
  const sendRichMessageRaw = (
    botToken: string,
    chatId: string,
    rich: { readonly markdown?: string; readonly html?: string },
    media: ReadonlyArray<RichCardMedia>,
    replyMarkup: unknown,
  ): Effect.Effect<{
    readonly ok: boolean;
    readonly messageId: number | null;
    readonly description: string | null;
  }> =>
    Effect.tryPromise({
      try: async () => {
        const richMessage = {
          ...(rich.html !== undefined ? { html: rich.html } : { markdown: rich.markdown ?? "" }),
          ...(media.length > 0 ? { media: richMediaField(media) } : {}),
        };
        const url = telegramApi(botToken, "sendRichMessage");
        let response: Response;
        if (media.length === 0) {
          response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              rich_message: richMessage,
              ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
            }),
          });
        } else {
          const form = new FormData();
          form.append("chat_id", chatId);
          form.append("rich_message", JSON.stringify(richMessage));
          if (replyMarkup !== undefined) form.append("reply_markup", JSON.stringify(replyMarkup));
          for (const entry of media) {
            const bytes = await fsPromises.readFile(entry.path);
            form.append(entry.id, new Blob([new Uint8Array(bytes)]), entry.name);
          }
          response = await fetch(url, { method: "POST", body: form });
        }
        return (await response.json()) as TelegramApiResponse;
      },
      catch: (cause) => redactConnectorSecrets(String(cause)),
    }).pipe(
      Effect.map((answer) =>
        answer.ok === true
          ? { ok: true, messageId: sentMessageId(answer.result), description: null }
          : { ok: false, messageId: null, description: answer.description ?? "refused" },
      ),
      Effect.catch((description) => Effect.succeed({ ok: false, messageId: null, description })),
    );

  /**
   * `sendWidget` (Bot API 10.4): an HTML + JS app in the message, answering
   * through `widget_query` when `allowQueries`. Not tried at all when the
   * html is over Telegram's limits (32 KB, 4 KB deflated). One attempt: a
   * refusal (an old relay: 403 "not available through the Uno relay", an
   * old Bot API, a group) falls back at the caller.
   */
  const sendWidgetRaw = (
    botToken: string,
    chatId: string,
    widget: {
      readonly html: string;
      readonly caption: string;
      /** A card: its words go above the widget, the main line bold. */
      readonly captionAbove?: boolean;
      readonly captionBold?: { readonly offset: number; readonly length: number };
      readonly chatData?: string;
      readonly width?: number;
      readonly height?: number;
      readonly allowQueries: boolean;
      readonly replyMarkup?: unknown;
    },
  ): Effect.Effect<{
    readonly ok: boolean;
    readonly messageId: number | null;
    readonly description: string | null;
  }> => {
    const tooBig = widgetSizeProblem(widget.html);
    if (tooBig !== null) {
      return Effect.succeed({ ok: false, messageId: null, description: tooBig });
    }
    return fetchJson(telegramApi(botToken, "sendWidget"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        html: widget.html,
        caption: widget.caption.slice(0, WIDGET_CAPTION_MAX_CHARS),
        ...(widget.captionAbove === true ? { show_caption_above_media: true } : {}),
        ...(widget.captionBold !== undefined && widget.captionBold.length > 0
          ? {
              caption_entities: [
                {
                  type: "bold",
                  offset: widget.captionBold.offset,
                  length: widget.captionBold.length,
                },
              ],
            }
          : {}),
        ...(widget.chatData !== undefined ? { chat_data: widget.chatData } : {}),
        ...(widget.width !== undefined ? { width: widget.width } : {}),
        ...(widget.height !== undefined ? { height: widget.height } : {}),
        allow_queries: widget.allowQueries,
        ...(widget.replyMarkup !== undefined ? { reply_markup: widget.replyMarkup } : {}),
      }),
    }).pipe(
      Effect.map((answer) =>
        answer.ok === true
          ? { ok: true, messageId: sentMessageId(answer.result), description: null }
          : { ok: false, messageId: null, description: answer.description ?? "refused" },
      ),
      Effect.catch((error) =>
        Effect.succeed({ ok: false, messageId: null, description: error.message }),
      ),
    );
  };

  /** A widget's `chat_data` (its state as it shows it, also when opened again). */
  const setWidgetData = (
    botToken: string,
    chatId: string,
    messageId: number | null | undefined,
    chatData: string,
  ) =>
    messageId === null || messageId === undefined
      ? Effect.void
      : callBotJson(botToken, "editMessageWidgetData", {
          chat_id: chatId,
          message_id: messageId,
          chat_data: chatData,
        }).pipe(
          Effect.flatMap((answer) =>
            answer.ok === true
              ? Effect.void
              : Effect.logInfo("telegram widget data not updated").pipe(
                  Effect.annotateLogs({ chatId, messageId, description: answer.description }),
                ),
          ),
        );

  /** Every widget request is answered, within 15 s, or it fails with TIMEOUT in the widget. */
  const answerWidgetQuery = (botToken: string, queryId: string, data?: string) =>
    callBotJson(botToken, "answerWidgetQuery", {
      widget_query_id: queryId,
      ...(data !== undefined ? { data } : {}),
    }).pipe(Effect.asVoid);

  /** A report's pictures and files: which go inside the Rich Message, which after it. */
  const planCardMedia = (images: ReadonlyArray<string>, files: ReadonlyArray<string>) =>
    Effect.promise(async () => {
      const embedded: RichCardMedia[] = [];
      const after: string[] = [];
      let bytes = 0;
      const entries = [
        ...images.map((path) => ({ path, picture: true })),
        ...files.map((path) => ({ path, picture: false })),
      ];
      for (const [index, entry] of entries.entries()) {
        const size = await fsPromises.stat(entry.path).then(
          (stat) => (stat.isFile() ? stat.size : -1),
          () => -1,
        );
        if (
          size < 0 ||
          size > TELEGRAM_BOT_UPLOAD_LIMIT_BYTES ||
          bytes + size > RICH_MESSAGE_MAX_UPLOAD_BYTES ||
          embedded.length >= RICH_MESSAGE_MAX_MEDIA
        ) {
          // sendTelegramFile says why one can't go (too big, gone).
          after.push(entry.path);
          continue;
        }
        bytes += size;
        const photo = entry.picture && size <= TELEGRAM_PHOTO_UPLOAD_LIMIT_BYTES;
        embedded.push({
          id: `${photo ? "img" : "doc"}${index + 1}`,
          kind: photo ? "photo" : "document",
          path: entry.path,
          name: nodePath.basename(entry.path),
        });
      }
      return { embedded, after };
    });

  /** The message id and reply route of a sent card. */
  const rememberCardMessage = (input: {
    readonly connectorProjectId: ProjectId;
    readonly chatId: string;
    readonly threadId: ThreadId;
    readonly groupId: string | null;
    readonly messageId: number | null;
    readonly routeReplies: boolean;
    readonly nowMs: number;
  }) =>
    input.messageId === null
      ? Effect.void
      : updateButtons((state) => {
          const messageId = input.messageId!;
          const withId =
            input.groupId === null ? state : setGroupMessageId(state, input.groupId, messageId);
          return input.routeReplies
            ? addSentMessageRoute(
                withId,
                {
                  connectorProjectId: input.connectorProjectId,
                  chatId: input.chatId,
                  messageId,
                  threadId: input.threadId,
                  atMs: input.nowMs,
                },
                input.nowMs,
              )
            : withId;
        }).pipe(Effect.asVoid);

  /** The quiz's current question as a native quiz poll; its poll id, or why not. */
  const sendQuizPoll = (botToken: string, quiz: CardQuiz) =>
    callBotJson(botToken, "sendPoll", { chat_id: quiz.chatId, ...quizPollParams(quiz) }).pipe(
      Effect.map((answer) => {
        const result = answer.result as
          | { readonly message_id?: number; readonly poll?: { readonly id?: string } }
          | undefined;
        const pollId = result?.poll?.id;
        return answer.ok === true && typeof pollId === "string"
          ? { ok: true as const, pollId, messageId: result?.message_id ?? null }
          : { ok: false as const, description: answer.description ?? "sendPoll refused" };
      }),
    );

  /**
   * A card as a widget (telegramWidgetCard.ts): a choice / report keeps a
   * ButtonGroup (`widget: true`), a quiz a CardQuiz (`widget: true`, no
   * poll), so their requests, the TTL and the idle flush work as for the
   * keyboard and the polls. Null: not drawable or refused — the caller
   * goes on with the Rich Message / polls, nothing of this attempt left.
   */
  const sendCardWidget = (
    via: { readonly projectId: ProjectId; readonly botToken: string },
    input: TelegramCardMessage,
    nowMs: number,
  ) =>
    Effect.gen(function* () {
      const language = input.language ?? "en";
      const card = input.card;
      const routeReplies = input.routeReplies === true;
      const quiz =
        card.kind === "quiz"
          ? {
              ...newCardQuiz({
                id: newButtonGroupId(),
                card,
                connectorProjectId: via.projectId,
                chatId: input.chatId,
                threadId: input.threadId,
                language,
                nowMs,
              }),
              widget: true,
            }
          : null;
      const rows = card.kind === "quiz" ? [] : cardButtons(card, language);
      const group: ButtonGroup | null =
        rows.length === 0
          ? null
          : {
              id: newButtonGroupId(),
              connectorProjectId: via.projectId,
              chatId: input.chatId,
              messageId: null,
              threadId: input.threadId,
              rows,
              widget: true,
              language,
              createdAtMs: nowMs,
              expiresAtMs: nowMs + CHOICE_BUTTONS_TTL_MS,
            };
      const rendered = renderPersonCardWidget(card, {
        header: input.header,
        language,
        // A report without actions sends nothing; its prefix is never used.
        requestPrefix: widgetRequestPrefix(quiz?.id ?? group?.id ?? newButtonGroupId()),
        fits: widgetFits,
      });
      if (rendered === null) return null;
      if (group !== null) yield* updateButtons((state) => addButtonGroup(state, group, nowMs));
      if (quiz !== null) yield* updateButtons((state) => putQuiz(state, quiz));
      const sent = yield* sendWidgetRaw(via.botToken, input.chatId, {
        html: rendered.html,
        caption: rendered.caption,
        captionAbove: true,
        ...(rendered.captionBold !== undefined ? { captionBold: rendered.captionBold } : {}),
        ...(rendered.chatData !== undefined ? { chatData: rendered.chatData } : {}),
        allowQueries: group !== null || quiz !== null,
      });
      if (!sent.ok) {
        yield* Effect.logInfo("telegram widget card refused, sending the rich card").pipe(
          Effect.annotateLogs({
            chatId: input.chatId,
            kind: card.kind,
            description: sent.description,
          }),
        );
        if (group !== null) yield* updateButtons((state) => removeButtonGroup(state, group.id));
        if (quiz !== null) yield* updateButtons((state) => removeQuiz(state, quiz.id));
        return null;
      }
      yield* recordDelivery(via.projectId, true, null);
      if (quiz !== null && sent.messageId !== null) {
        const messageId = sent.messageId;
        yield* updateButtons((state) => ({
          ...state,
          quizzes: (state.quizzes ?? []).map((entry) =>
            entry.id === quiz.id ? { ...entry, messageId } : entry,
          ),
        }));
      }
      yield* rememberCardMessage({
        connectorProjectId: via.projectId,
        chatId: input.chatId,
        threadId: input.threadId,
        groupId: group?.id ?? null,
        messageId: sent.messageId,
        routeReplies,
        nowMs,
      });
      // A report's files follow as documents (pictures never make a widget).
      let error: string | null = null;
      for (const path of input.files ?? []) {
        const file = yield* sendTelegramFile(via.projectId, via.botToken, input.chatId, path, {
          language,
        });
        if (!file.ok) error = file.error;
      }
      return { ok: true, error, drawn: "widget" as const };
    });

  const sendCard: ManagerTelegramServiceShape["sendCard"] = (input) =>
    Effect.gen(function* () {
      const config = yield* readRow(input.projectId);
      if (config === null || !config.enabled) {
        return { ok: false, error: "Telegram is not connected.", drawn: "none" as const };
      }
      const via = yield* resolveSendRow(input.projectId, config);
      if (via === null) {
        return { ok: false, error: "Telegram is not connected.", drawn: "none" as const };
      }
      const language = input.language ?? "en";
      const nowMs = Date.now();
      const card = input.card;
      const routeReplies = input.routeReplies === true;
      const plainText = cardPlainText(card, input.header, language).slice(
        0,
        TELEGRAM_MESSAGE_LIMIT,
      );

      // A private chat: the card as a widget first (Bot API 10.4). Not
      // drawable (pictures, too tall) or refused → the Rich Message / polls.
      if (isPrivateTelegramChatId(input.chatId)) {
        const widget = yield* sendCardWidget(via, input, nowMs);
        if (widget !== null) return widget;
      }

      if (card.kind === "quiz") {
        const intro = yield* sendTelegramText(
          via.projectId,
          via.botToken,
          input.chatId,
          quizIntroText(card, input.header, language),
        );
        if (!intro.ok) {
          return {
            ok: false,
            error: intro.description ?? "Telegram refused the message.",
            drawn: "none" as const,
          };
        }
        yield* rememberCardMessage({
          connectorProjectId: via.projectId,
          chatId: input.chatId,
          threadId: input.threadId,
          groupId: null,
          messageId: intro.messageId ?? null,
          routeReplies,
          nowMs,
        });
        const quiz = newCardQuiz({
          id: newButtonGroupId(),
          card,
          connectorProjectId: via.projectId,
          chatId: input.chatId,
          threadId: input.threadId,
          language,
          nowMs,
        });
        const poll = yield* sendQuizPoll(via.botToken, quiz);
        if (poll.ok) {
          yield* updateButtons((state) => putQuiz(state, { ...quiz, pollId: poll.pollId }));
          return { ok: true, error: null, drawn: "poll" as const };
        }
        yield* Effect.logInfo("telegram quiz poll refused, sending the quiz as text").pipe(
          Effect.annotateLogs({ chatId: input.chatId, description: poll.description }),
        );
        const text = yield* sendTelegramText(
          via.projectId,
          via.botToken,
          input.chatId,
          cardPlainText(card, null, language).slice(0, TELEGRAM_MESSAGE_LIMIT),
        );
        if (!text.ok) {
          return {
            ok: false,
            error: text.description ?? "Telegram refused the message.",
            drawn: "none" as const,
          };
        }
        yield* rememberCardMessage({
          connectorProjectId: via.projectId,
          chatId: input.chatId,
          threadId: input.threadId,
          groupId: null,
          messageId: text.messageId ?? null,
          routeReplies,
          nowMs,
        });
        return { ok: true, error: null, drawn: "text" as const };
      }

      const plan =
        card.kind === "report"
          ? yield* planCardMedia(input.images ?? [], input.files ?? [])
          : { embedded: [], after: [] };
      const rows = cardButtons(card, language);
      const group: ButtonGroup | null =
        rows.length === 0
          ? null
          : {
              id: newButtonGroupId(),
              connectorProjectId: via.projectId,
              chatId: input.chatId,
              messageId: null,
              threadId: input.threadId,
              rows,
              text: plainText,
              rich: true,
              language,
              createdAtMs: nowMs,
              expiresAtMs: nowMs + CHOICE_BUTTONS_TTL_MS,
            };
      if (group !== null) yield* updateButtons((state) => addButtonGroup(state, group, nowMs));
      const replyMarkup = group === null ? undefined : buildInlineKeyboard(group);
      const markdown = cardRichMarkdown(card, {
        header: input.header,
        language,
        media: plan.embedded,
        notEmbedded: plan.after.map((path) => nodePath.basename(path)),
      });
      const rich = yield* sendRichMessageRaw(
        via.botToken,
        input.chatId,
        { markdown },
        plan.embedded,
        replyMarkup,
      );
      if (rich.ok) {
        yield* recordDelivery(via.projectId, true, null);
        yield* rememberCardMessage({
          connectorProjectId: via.projectId,
          chatId: input.chatId,
          threadId: input.threadId,
          groupId: group?.id ?? null,
          messageId: rich.messageId,
          routeReplies,
          nowMs,
        });
        let error: string | null = null;
        for (const path of plan.after) {
          const file = yield* sendTelegramFile(via.projectId, via.botToken, input.chatId, path, {
            language,
          });
          if (!file.ok) error = file.error;
        }
        return { ok: true, error, drawn: "rich" as const };
      }
      yield* Effect.logInfo("telegram rich card refused, sending plain text").pipe(
        Effect.annotateLogs({ chatId: input.chatId, description: rich.description }),
      );
      if (group !== null) {
        yield* updateButtons((state) => ({
          ...state,
          groups: state.groups.map((entry) =>
            entry.id === group.id ? { ...entry, rich: false } : entry,
          ),
        }));
      }
      const sent = yield* sendTelegramText(
        via.projectId,
        via.botToken,
        input.chatId,
        plainText,
        replyMarkup === undefined ? {} : { replyMarkup },
      );
      if (!sent.ok) {
        if (group !== null) yield* updateButtons((state) => removeButtonGroup(state, group.id));
        return {
          ok: false,
          error: sent.description ?? "Telegram refused the message.",
          drawn: "none" as const,
        };
      }
      yield* rememberCardMessage({
        connectorProjectId: via.projectId,
        chatId: input.chatId,
        threadId: input.threadId,
        groupId: group?.id ?? null,
        messageId: sent.messageId ?? null,
        routeReplies,
        nowMs,
      });
      let error: string | null = null;
      for (const path of [...plan.embedded.map((entry) => entry.path), ...plan.after]) {
        const file = yield* sendTelegramFile(via.projectId, via.botToken, input.chatId, path, {
          language,
        });
        if (!file.ok) error = file.error;
      }
      return { ok: true, error, drawn: "text" as const };
    });

  /**
   * The quiz's state moves only from the step this caller saw (`advanceQuiz`,
   * `takeQuiz`), inside one update: an answer and the idle flush racing never
   * send two scores, nor bring a finished quiz back.
   */
  const changeQuiz = (
    change: (state: ConnectorButtonsState) => {
      readonly state: ConnectorButtonsState;
      readonly applied: boolean;
    },
  ) =>
    Effect.gen(function* () {
      let applied = false;
      yield* updateButtons((state) => {
        const result = change(state);
        applied = result.applied;
        return result.state;
      });
      return applied;
    });

  /**
   * A quiz ends (all answered, or left for a while): ONE message with the
   * score. `seen`: the quiz as the caller read it; if it has moved since
   * (another answer, the idle flush), someone else ends it and this sends nothing.
   */
  const finishQuiz = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    quiz: CardQuiz,
    options: { readonly stopped?: boolean; readonly seen?: CardQuiz } = {},
  ) =>
    Effect.gen(function* () {
      const taken = yield* changeQuiz((state) => takeQuiz(state, options.seen ?? quiz));
      if (!taken) return;
      // A widget quiz shows itself finished (no poll to stop: it has none).
      if (quiz.widget === true) {
        yield* setWidgetData(
          config.botToken,
          quiz.chatId,
          quiz.messageId,
          widgetQuizDoneState(quiz),
        );
      }
      if (quiz.answers.length === 0) return;
      yield* answerAsPerson({
        projectId,
        config,
        chatId: quiz.chatId,
        chatLabel: quiz.chatId,
        threadId: quiz.threadId,
        text: quizSummaryText(quiz, options),
        replyKey: `${quiz.chatId}:quiz:${quiz.id}`,
        replyTo: null,
        language: quiz.language ?? "en",
      });
    });

  /** An answer to a quiz poll: only the owner's, only for the question on screen. */
  const handlePollAnswer = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    answer: TelegramPollAnswer,
  ) =>
    Effect.gen(function* () {
      const quiz = findQuizByPoll(yield* Ref.get(buttonsRef), answer.poll_id);
      if (quiz === null || quiz.connectorProjectId !== projectId) return;
      const userId = answer.user?.id;
      if (userId === undefined || answer.user?.is_bot === true) return;
      const routedRows = yield* routedRowsOf(projectId);
      const access = mergeRoutedAccess(
        config,
        routedRows.map((row) => row.config),
      );
      const owner = String(userId) === quiz.chatId || access.ownerUserIds.includes(String(userId));
      if (!owner) return;
      const step = answerQuiz(quiz, answer.option_ids ?? [], Date.now());
      if (step.kind === "ignore") return;
      if (step.kind === "done") {
        yield* finishQuiz(projectId, config, step.quiz, { seen: quiz });
        return;
      }
      // Only if nobody finished it meanwhile (the idle flush sent its score).
      if (!(yield* changeQuiz((state) => advanceQuiz(state, quiz, step.quiz)))) return;
      const poll = yield* sendQuizPoll(config.botToken, step.quiz);
      if (poll.ok) {
        yield* changeQuiz((state) =>
          advanceQuiz(state, step.quiz, { ...step.quiz, pollId: poll.pollId }),
        );
        return;
      }
      // The next question would not go: what was answered goes now.
      yield* finishQuiz(projectId, config, step.quiz, { stopped: true });
    }).pipe(
      Effect.catchTag("TelegramRoutingError", (error) =>
        Effect.logWarning("telegram quiz answer not routed").pipe(
          Effect.annotateLogs({ projectId, reason: error.message }),
        ),
      ),
    );

  /**
   * A request of one of our widgets. Answered FIRST (Telegram gives 15 s),
   * then the message's `chat_data` mirrors the answer, then the person's
   * message goes to the chat — once: a group is spent and a quiz moves on
   * inside one state update, so a double tap or an idle flush racing it
   * changes nothing twice. Only the owner, in the private chat it went to.
   */
  const handleWidgetQuery = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    query: TelegramWidgetQuery,
  ) =>
    Effect.gen(function* () {
      const botToken = config.botToken;
      const answer = (data?: string) => answerWidgetQuery(botToken, query.id, data);
      if (query.type?.type !== undefined && query.type.type !== "data") {
        // A wallet request (sign_data, sent_transaction): not something we sent.
        yield* answer();
        return;
      }
      const fromId = query.from?.id;
      const chatIdNumber = query.chat?.id ?? fromId;
      const messageId = query.message_id;
      if (fromId === undefined || chatIdNumber === undefined || query.from?.is_bot === true) {
        yield* answer(WIDGET_EXPIRED_STATE);
        return;
      }
      const chatId = String(chatIdNumber);
      const routedRows = yield* routedRowsOf(projectId);
      const access = mergeRoutedAccess(
        config,
        routedRows.map((row) => row.config),
      );
      const owner =
        access.allowedChatIds.includes(chatId) &&
        (String(fromId) === chatId || access.ownerUserIds.includes(String(fromId)));
      const nowMs = Date.now();
      const state = yield* Ref.get(buttonsRef);
      const request = parseWidgetRequest(query.data);
      const ours = (entry: { readonly connectorProjectId: string; readonly chatId: string }) =>
        entry.connectorProjectId === projectId && entry.chatId === chatId;
      const language = detectReplyLanguage("", query.from?.language_code);
      const refuse = (reason: string) =>
        Effect.gen(function* () {
          yield* answer(WIDGET_EXPIRED_STATE);
          yield* Effect.logInfo("telegram widget request refused").pipe(
            Effect.annotateLogs({ projectId, chatId, reason }),
          );
        });
      const asPerson = (threadId: string, text: string, replyLanguage: ReplyLanguage) =>
        answerAsPerson({
          projectId,
          config,
          chatId,
          chatLabel: query.chat?.title ?? query.chat?.username ?? chatId,
          threadId,
          text,
          replyKey: `${chatId}:wq:${query.id}`,
          replyTo: messageId === undefined ? null : String(messageId),
          language: replyLanguage,
        });

      // A card's quiz.
      const quiz =
        request === null
          ? undefined
          : (state.quizzes ?? []).find((entry) => entry.id === request.id && entry.widget === true);
      if (request !== null && quiz !== undefined && request.question !== null) {
        if (!ours(quiz) || !owner) return yield* refuse("not the owner's chat");
        const verdict = answerWidgetQuiz(quiz, request.question, request.picks, nowMs);
        if (verdict.kind === "stale") {
          yield* answer(verdict.state);
          return;
        }
        if (verdict.kind === "done") {
          yield* answer(verdict.state);
          yield* finishQuiz(projectId, config, verdict.quiz, { seen: quiz });
          return;
        }
        if (!(yield* changeQuiz((current) => advanceQuiz(current, quiz, verdict.quiz)))) {
          // Moved meanwhile (the idle flush finished it): it shows that.
          yield* answer(widgetQuizDoneState(quiz));
          return;
        }
        yield* answer(verdict.state);
        yield* setWidgetData(botToken, chatId, messageId ?? quiz.messageId, verdict.state);
        return;
      }

      // A card's choice or report.
      const group =
        request === null || request.question !== null
          ? undefined
          : state.groups.find((entry) => entry.id === request.id && entry.widget === true);
      if (request !== null && group !== undefined && group.expiresAtMs > nowMs) {
        if (!ours(group) || !owner) return yield* refuse("not the owner's chat");
        const groupLanguage = group.language ?? language;
        const verdict = decideWidgetPick(group, request.picks, groupLanguage);
        if (verdict.kind === "bad") {
          yield* answer('{"e":"bad"}');
          return;
        }
        if (verdict.kind === "spent") {
          yield* answer(verdict.state);
          return;
        }
        if (!(yield* changeQuiz((current) => spendWidgetGroup(current, group.id, verdict.picks)))) {
          // A double tap: the first one answered the chat already.
          const spent = (yield* Ref.get(buttonsRef)).groups.find((entry) => entry.id === group.id);
          const again =
            spent === undefined ? null : decideWidgetPick(spent, verdict.picks, groupLanguage);
          yield* answer(again?.kind === "spent" ? again.state : WIDGET_EXPIRED_STATE);
          return;
        }
        yield* answer(verdict.state);
        yield* setWidgetData(botToken, chatId, messageId ?? group.messageId, verdict.state);
        yield* asPerson(group.threadId, verdict.text, groupLanguage);
        yield* Effect.logInfo("telegram widget card answered").pipe(
          Effect.annotateLogs({
            projectId,
            chatId,
            picked: widgetPickLabels(group, verdict.picks),
          }),
        );
        return;
      }

      // An agent's own widget: its text goes to the chat that sent it.
      const agentWidget =
        messageId === undefined
          ? null
          : findAgentWidget(state, { connectorProjectId: projectId, chatId, messageId, nowMs });
      const data = (query.data ?? "").trim();
      if (agentWidget !== null && request === null && data !== "") {
        if (!owner) return yield* refuse("not the owner's chat");
        let admitted = false;
        yield* updateButtons((current) => {
          const verdict = admitAgentWidgetRequest(current, agentWidget, nowMs);
          admitted = verdict.admitted;
          return verdict.state;
        });
        if (!admitted) {
          yield* answer(AGENT_WIDGET_SLOW);
          return;
        }
        yield* answer(AGENT_WIDGET_OK);
        yield* asPerson(agentWidget.threadId, agentWidgetMessage(agentWidget, data), language);
        return;
      }

      // Gone (expired, answered on another device long ago) or unknown.
      yield* answer(WIDGET_EXPIRED_STATE);
      // A choice's card shows it when opened again; a quiz's keeps its score.
      if (request !== null && request.question === null && owner) {
        yield* setWidgetData(botToken, chatId, messageId, WIDGET_EXPIRED_STATE);
      }
    }).pipe(
      Effect.catchTag("TelegramRoutingError", (error) =>
        Effect.logWarning("telegram widget request not routed").pipe(
          Effect.annotateLogs({ projectId, reason: error.message }),
        ),
      ),
    );

  /** Quizzes left half answered: their score goes to the chat (once per poll cycle). */
  const flushIdleQuizzes = Effect.gen(function* () {
    const idle = idleQuizzes(yield* Ref.get(buttonsRef), Date.now());
    for (const quiz of idle) {
      const projectId = ProjectId.make(quiz.connectorProjectId);
      const config = yield* readRow(projectId);
      if (config === null) {
        yield* updateButtons((state) => removeQuiz(state, quiz.id));
        continue;
      }
      yield* finishQuiz(projectId, config, quiz, { stopped: true }).pipe(
        Effect.catchTag("TelegramRoutingError", () =>
          updateButtons((state) => removeQuiz(state, quiz.id)).pipe(Effect.asVoid),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("telegram idle quizzes not flushed").pipe(Effect.annotateLogs({ cause })),
    ),
  );

  const retireRequestButtons: ManagerTelegramServiceShape["retireRequestButtons"] = (requestId) =>
    Effect.gen(function* () {
      const groups = groupsForRequest(yield* Ref.get(buttonsRef), requestId);
      if (groups.length === 0) return;
      yield* updateButtons((state) =>
        groups.reduce((next, group) => removeButtonGroup(next, group.id), state),
      );
      for (const group of groups) {
        const botToken = yield* botTokenOf(ProjectId.make(group.connectorProjectId));
        if (botToken === null) continue;
        yield* finishButtonMessage(botToken, group, answeredElsewhereLine(group.language ?? "en"));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("telegram request buttons not retired").pipe(
          Effect.annotateLogs({ requestId, cause }),
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
    options: { readonly silent: boolean },
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
      // Linking happens only from a private chat, whose id is the user's id:
      // that user is recorded as an owner (the only sender groups obey).
      const ownerUserIds = withOwnerUserId(base.ownerUserIds, String(message.from?.id ?? chatId));
      if (!base.allowedChatIds.includes(chatId) || ownerUserIds !== (base.ownerUserIds ?? [])) {
        yield* connectorRepository.upsert({
          projectId,
          kind: "telegram",
          config: {
            ...base,
            allowedChatIds: base.allowedChatIds.includes(chatId)
              ? base.allowedChatIds
              : [...base.allowedChatIds, chatId],
            ownerUserIds,
          },
          updatedAt: new Date().toISOString(),
        });
      }
      let toMainConversation = false;
      // Its name in the hello: the pinned chat's title, else the assistant's.
      let assistantName: string | null = null;
      if (projectId === ASSISTANT_PROJECT_ID && isPrivateTelegramChat(message.chat)) {
        const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
        const main = findMarkedAssistantChat(snapshot.threads);
        if (main !== null) {
          assistantName = main.title;
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
        Effect.annotateLogs({ projectId, chatId, toMainConversation, silent: options.silent }),
      );
      // The console already said hello for Uno's assistant bot.
      if (options.silent) return;
      yield* sendTelegramText(
        projectId,
        config.botToken,
        chatId,
        telegramLinkedReply({
          toMainConversation,
          viaSharedBot: isRelayCredential(config.botToken),
          name:
            assistantName ??
            (yield* projectionSnapshotQuery.getProjectShellById(projectId).pipe(
              Effect.map((project) => (Option.isSome(project) ? project.value.title : null)),
              Effect.orElseSucceed(() => null),
            )),
          languageCode: message.from?.language_code ?? null,
        }),
      );
    });

  /**
   * `/start <code>` of another assistant of this computer, arriving through
   * the bot this connector holds (Uno's shared bot, one relay per computer):
   * the chat is allowlisted on THAT assistant's routed row, and bound to it —
   * the default assistant's private chat to its main conversation, any other
   * assistant as a target of its own. The code is spent.
   */
  const linkRoutedChat = (
    holder: ProjectId,
    holderConfig: ManagerTelegramConnectorConfig,
    assistantId: ProjectId,
    message: TelegramIncomingMessage,
    options: { readonly silent: boolean },
  ) =>
    Effect.gen(function* () {
      const chatId = String(message.chat?.id);
      yield* Ref.update(pairingsRef, (map) => {
        const next = new Map(map);
        next.delete(assistantId);
        return next;
      });
      const routed = yield* readRow(assistantId);
      if (routed !== null) {
        const ownerUserIds = withOwnerUserId(
          routed.ownerUserIds,
          String(message.from?.id ?? chatId),
        );
        yield* connectorRepository.upsert({
          projectId: assistantId,
          kind: "telegram",
          config: {
            ...routed,
            allowedChatIds: routed.allowedChatIds.includes(chatId)
              ? routed.allowedChatIds
              : [...routed.allowedChatIds, chatId],
            ownerUserIds,
          },
          updatedAt: new Date().toISOString(),
        });
      }
      let target: ManagerConnectorBindingTarget = { kind: "assistant", projectId: assistantId };
      if (assistantId === ASSISTANT_PROJECT_ID) {
        const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
        const main = findMarkedAssistantChat(snapshot.threads);
        if (main !== null) target = { kind: "thread", threadId: main.id };
      }
      const existing = yield* bindingRepository.get({ kind: "telegram", chatId });
      yield* bindingRepository.upsert({
        kind: "telegram",
        chatId,
        connectorProjectId: holder,
        target,
        notifyOnComplete: Option.isSome(existing) ? existing.value.notifyOnComplete : false,
        updatedAt: new Date().toISOString(),
      });
      const project = yield* projectionSnapshotQuery
        .getProjectShellById(assistantId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const name = Option.isSome(project) ? project.value.title : null;
      yield* Effect.logInfo("telegram chat linked by code to a routed assistant").pipe(
        Effect.annotateLogs({ holder, assistantId, chatId, target: target.kind }),
      );
      if (options.silent) return;
      yield* sendTelegramText(
        holder,
        holderConfig.botToken,
        chatId,
        telegramRoutedLinkedReply({ name }),
      );
    });

  const handleUpdate = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    update: TelegramUpdate,
    /** The other parts of its album, gathered ({@link TELEGRAM_ALBUM_GATHER_MS}). */
    albumSiblings?: ReadonlyArray<TelegramIncomingMessage>,
  ) =>
    Effect.gen(function* () {
      if (update.callback_query !== undefined) {
        yield* handleCallbackQuery(projectId, config, update.callback_query);
        return;
      }
      if (update.poll_answer !== undefined) {
        yield* handlePollAnswer(projectId, config, update.poll_answer);
        return;
      }
      if (update.widget_query !== undefined) {
        yield* handleWidgetQuery(projectId, config, update.widget_query);
        return;
      }
      const message = update.message;
      const chatIdNumber = message?.chat?.id;
      if (message === undefined || chatIdNumber === undefined) {
        return;
      }
      // An album comes as one update per photo/file: the first part waits a
      // moment for the rest, then they go as ONE message; later parts only
      // join it.
      const albumKey = telegramAlbumKey(message);
      if (albumKey !== null && albumSiblings === undefined) {
        const key = `${projectId}:${albumKey}`;
        const albums = yield* Ref.get(albumsRef);
        const gathering = albums.get(key);
        if (gathering !== undefined) {
          yield* Ref.update(albumsRef, (map) => new Map(map).set(key, [...gathering, update]));
          return;
        }
        yield* Ref.update(albumsRef, (map) => new Map(map).set(key, [update]));
        yield* Effect.sleep(TELEGRAM_ALBUM_GATHER_MS).pipe(
          Effect.andThen(
            Ref.modify(albumsRef, (map) => {
              const parts = map.get(key) ?? [update];
              const next = new Map(map);
              next.delete(key);
              return [parts, next] as const;
            }),
          ),
          Effect.flatMap((parts) => {
            // The part with the caption leads (it carries the text).
            const lead =
              parts.find((part) => (part.message?.caption ?? "").trim().length > 0) ?? parts[0]!;
            const rest = parts
              .filter((part) => part !== lead)
              .flatMap((part) => (part.message === undefined ? [] : [part.message]));
            return albumHandler.run === undefined
              ? Effect.void
              : albumHandler.run(projectId, config, lead, rest);
          }),
          Effect.forkDetach,
        );
        return;
      }
      const forwardedFrom = describeForwardOrigin(message.forward_origin);
      const ownText = (message.text ?? message.caption ?? "").trim();
      const text =
        forwardedFrom !== null && ownText.length > 0
          ? wrapForwardedText(forwardedFrom, ownText)
          : ownText;
      const files = collectMessageFiles(message, albumSiblings ?? []);
      const media = files.media;
      const nonFileLines = [
        ...describeNonFileContent(message),
        ...(forwardedFrom !== null && ownText.length === 0
          ? [`[Forwarded from ${forwardedFrom}.]`]
          : []),
      ];
      if (text.length === 0 && media.length === 0 && nonFileLines.length === 0) {
        return;
      }
      const chatId = String(chatIdNumber);
      // Other assistants of this computer that talk through this bot (Uno's
      // shared bot: one relay per computer, see `channelRelay.ts`).
      const routedRows = yield* routedRowsOf(projectId);
      const startPayload = parseTelegramStartPayload(text);
      if (startPayload !== null) {
        const pairings = yield* Ref.get(pairingsRef);
        const nowMs = Date.now();
        const linkFor = matchesTelegramPairing(pairings.get(projectId), startPayload, nowMs)
          ? projectId
          : (routedRows.find((row) =>
              matchesTelegramPairing(pairings.get(row.projectId), startPayload, nowMs),
            )?.projectId ?? null);
        if (linkFor !== null) {
          // Only a person, in a private chat with the bot, can link: a group
          // would hand every member of it the owner's assistant.
          const fromId = message.from?.id === undefined ? null : String(message.from.id);
          if (
            !isPrivateTelegramChat(message.chat) ||
            message.from?.is_bot === true ||
            fromId !== chatId
          ) {
            yield* Effect.logInfo("telegram link code used outside a private chat; refused").pipe(
              Effect.annotateLogs({ projectId, chatId }),
            );
            if (message.from?.is_bot !== true) {
              yield* sendTelegramText(
                projectId,
                config.botToken,
                chatId,
                "Link Telegram from a private chat with this bot. Groups can be added in Uno Work settings.",
              );
            }
            return;
          }
          // Uno's assistant bot answers the person itself (`uno_linked`);
          // honoured only on that bot's relay, never on an own bot.
          const silent = update.uno_linked === true && isAssistantBotRelay(config.botToken);
          if (linkFor === projectId) {
            yield* linkChat(projectId, config, message, { silent });
          } else {
            yield* linkRoutedChat(projectId, config, linkFor, message, { silent });
          }
          return;
        }
      }
      // Chats linked to the routed assistants are this bot's chats too.
      const access = mergeRoutedAccess(
        config,
        routedRows.map((row) => row.config),
      );
      // --- Who writes in groups (telegramGroups.ts). In a group the bot
      // answers in: everyone, so the owner can pick people by name. In any
      // other group: only the owner, so the group can be added with a button.
      // Uno's shared bot never takes groups.
      const inGroup = !isPrivateTelegramChat(message.chat);
      const fromOwner =
        message.from?.id !== undefined &&
        message.from.is_bot !== true &&
        telegramOwnerUserIds(access).has(String(message.from.id));
      if (
        inGroup &&
        message.from !== undefined &&
        !isRelayCredential(config.botToken) &&
        (access.allowedChatIds.includes(chatId) || fromOwner)
      ) {
        const from = message.from;
        yield* updateGroups((directory) =>
          recordGroupSender(directory, {
            connectorProjectId: projectId,
            chatId,
            title: message.chat?.title,
            from,
            nowIso: new Date().toISOString(),
          }),
        );
      }
      if (!access.allowedChatIds.includes(chatId)) {
        yield* Effect.logDebug("telegram message from non-allowlisted chat ignored").pipe(
          Effect.annotateLogs({ projectId, chatId }),
        );
        // The owner called the bot in a group that is not added yet: say
        // where to add it (at most every few minutes), instead of silence.
        if (inGroup && fromOwner && !isRelayCredential(config.botToken)) {
          const called = toNormalizedMessage({
            message,
            botUsername: (yield* getRuntime(projectId)).botUsername,
            text,
          });
          const nowMs = Date.now();
          const last = (yield* Ref.get(strangerRepliesRef)).get(`${projectId}:${chatId}`);
          if (
            (called.explicitMention || called.isReplyToBot) &&
            shouldReplyToStranger(last, nowMs)
          ) {
            yield* Ref.update(strangerRepliesRef, (map) =>
              new Map(map).set(`${projectId}:${chatId}`, nowMs),
            );
            yield* sendTelegramText(
              projectId,
              config.botToken,
              chatId,
              "I don't answer in this group yet. Add it in Uno Work: Settings, Assistant, Telegram. There you also choose who I listen to here.",
            );
          }
        }
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

      // --- Who is writing. An allowlisted group is not an allowlisted person:
      // only the owner drives the assistant; other members are ignored unless
      // the owner let them in, and then run approval-required only.
      const senderRole: ConnectorSenderRole = classifyTelegramSender({
        chat: message.chat,
        from: message.from,
        allowedChatIds: access.allowedChatIds,
        ownerUserIds: access.ownerUserIds,
        groupAccess: telegramGroupAccess(config, chatId),
      });
      if (senderRole === "ignore") {
        yield* Effect.logDebug("telegram message from a non-owner sender ignored").pipe(
          Effect.annotateLogs({ projectId, chatId }),
        );
        return;
      }

      const botUsername = (yield* getRuntime(projectId)).botUsername;

      // --- Chat commands (`/use`, `/where`, `/approve`, …) come before the
      // addressing gate: they steer the transport itself and never reach a
      // harness. Anything else is message text for the bound target.
      const command = parseConnectorCommand(text, botUsername);
      if (command !== null) {
        // Commands rebind the chat and resolve approvals: owner only.
        if (senderRole !== "owner") {
          yield* Effect.logDebug("telegram command from a non-owner ignored").pipe(
            Effect.annotateLogs({ projectId, chatId }),
          );
          return;
        }
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
            senderIsOwner: senderRole === "owner",
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
        media.some(isGatingSpeechMedia)
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

      // --- Limits, before anything is downloaded: over Telegram's 20 MB bot
      // download limit, or longer than the assistant takes. The person hears
      // why; the turn runs only if something else is left (text, caption,
      // another file).
      const replyTo = message.message_id === undefined ? null : String(message.message_id);
      const takenMedia: Array<TelegramMediaDescriptor> = [];
      const refusedNotes: Array<string> = [];
      const limitReply = {
        language: detectReplyLanguage(text, message.from?.language_code),
        moreUrl: currentWorkAddress() ?? UNO_WORK_OPEN_URL,
      };
      for (const descriptor of media) {
        const refusal = mediaLimitReply(descriptor, limitReply);
        if (refusal === null) {
          takenMedia.push(descriptor);
          continue;
        }
        refusedNotes.push(
          `[Not passed to you: ${refusal} The person already got exactly this line: don't repeat it. If the message asks nothing else, answer exactly NO_REPLY.]`,
        );
        yield* sendTelegramText(projectId, config.botToken, chatId, refusal, { replyTo });
      }
      if (
        refusedNotes.length > 0 &&
        text.length === 0 &&
        nonFileLines.length === 0 &&
        takenMedia.length === 0
      ) {
        yield* Effect.logInfo("telegram media over the limits; no turn").pipe(
          Effect.annotateLogs({ projectId, chatId }),
        );
        return;
      }

      const chatLabel = message.chat?.title ?? message.chat?.username ?? chatId;
      // Where this chat's messages go: its binding, or the assistant that
      // owns the bot when it has none — except that a personal (private)
      // chat of the default assistant talks to its main conversation, the
      // pinned "Uno" chat (0.0.86). Groups keep a thread of their own.
      // Only this bot's binding counts: a private chat has the same id with
      // every bot (two assistants, each with a bot of its own).
      const binding = bindingOnConnector(
        Option.getOrNull(
          yield* bindingRepository
            .get({ kind: "telegram", chatId })
            .pipe(Effect.orElseSucceed(() => Option.none())),
        ),
        projectId,
      );
      const isPrivateChat = isPrivateTelegramChat(message.chat);
      const mainThreadId = routesToMainConversation({
        connectorProjectId: projectId,
        binding,
        isPrivateChat,
      })
        ? yield* findLiveMainConversationId
        : null;
      // The owner's reply to a message a chat sent them ("💬 <chat>") goes
      // back to that chat, whatever this chat is bound to.
      const replyRoute =
        senderRole === "owner" ? yield* replyRouteOf(projectId, chatId, message) : null;
      const target: ManagerConnectorBindingTarget =
        replyRoute !== null
          ? { kind: "thread", threadId: replyRoute }
          : resolveChatTarget({
              connectorProjectId: projectId,
              binding,
              isPrivateChat,
              mainThreadId,
            });
      // An assistant routed through this bot that the person paused.
      const targetAssistant =
        target.kind === "assistant"
          ? target.projectId
          : mainThreadId !== null && target.kind === "thread" && target.threadId === mainThreadId
            ? ASSISTANT_PROJECT_ID
            : null;
      const pausedRoute =
        targetAssistant !== null && targetAssistant !== projectId
          ? routedRows.find((row) => row.projectId === targetAssistant && !row.config.enabled)
          : undefined;
      if (pausedRoute !== undefined) {
        yield* Effect.logInfo("telegram message for a paused assistant").pipe(
          Effect.annotateLogs({ projectId, chatId, assistant: pausedRoute.projectId }),
        );
        if (isPrivateChat) {
          yield* sendTelegramText(
            projectId,
            config.botToken,
            chatId,
            "This assistant is paused in Uno Work. Turn it back on there, or send /assistant to talk to another one.",
          );
        }
        return;
      }
      // A replayed update (crash after it was taken) already has its reply
      // on the way: never a second turn for one message.
      const replyKey = `${chatId}:${message.message_id ?? `u${update.update_id}`}`;
      if (yield* replies.isKnown(projectId, replyKey)) {
        yield* Effect.logInfo("telegram message already has a pending reply; skipped").pipe(
          Effect.annotateLogs({ projectId, chatId, replyKey }),
        );
        return;
      }
      const { threadId, handoffContext, runtimeMode, interactionMode } = yield* ensureThreadForChat(
        {
          target,
          chatId,
          chatLabel,
          config,
          senderRole,
        },
      );
      const ingested =
        takenMedia.length > 0
          ? yield* ingestIncomingMedia({
              botToken: config.botToken,
              threadId,
              chatId,
              media: takenMedia,
              precomputedTranscripts,
              sender: message.from?.first_name ?? message.from?.username ?? "the person",
              fromReply: files.fromReply,
            })
          : { attachments: [], notes: [] };
      const bodyParts = [text, ...nonFileLines, ...ingested.notes, ...refusedNotes].filter(
        (part) => part.length > 0,
      );
      if (bodyParts.length === 0) {
        bodyParts.push("[The user sent the attached image(s) without a caption.]");
      }
      // A member's chat is shared by everyone the owner let in: say who
      // writes, and that it is not the owner.
      const memberLine =
        senderRole === "member" && message.from !== undefined
          ? `[From ${plainForLine(telegramPersonName(message.from))}${
              message.from.username ? ` (@${plainForLine(message.from.username)})` : ""
            }, a member of the Telegram group "${plainForLine(chatLabel)}" — not your owner. Don't share the owner's private data with them; anything you do here waits for the owner's OK.]`
          : null;
      if (senderRole === "member" && outsideThreads !== null) {
        yield* outsideThreads.mark(threadId);
      }
      const body = [
        ...(memberLine !== null ? [memberLine] : []),
        ...bodyParts,
        TELEGRAM_SEND_FILE_HINT,
      ].join("\n\n");
      const messageText =
        handoffContext === null ? body : [wrapHandoffPreamble(handoffContext), "", body].join("\n");
      yield* replies.enqueue({
        connectorProjectId: projectId,
        replyKey,
        chatId,
        replyTo,
        replyThread: null,
        threadId,
        language: detectReplyLanguage(effectiveText, message.from?.language_code),
        // Inherited from the routing decision: the assistant's fixed mode,
        // or whatever the bound project / thread runs in. Never widened here.
        dispatch: {
          text: messageText,
          attachments: ingested.attachments,
          runtimeMode,
          interactionMode,
        },
        extraMeta: { hotKey },
      });
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

  albumHandler.run = (projectId, config, lead, rest) =>
    handleUpdate(projectId, config, lead, rest).pipe(Effect.ignore);

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
        fingerprint,
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

  const machineIdentity = serverSettingsService.getSettings.pipe(
    Effect.map((settings) => readWorkMachineIdentity(settings.uno)),
    Effect.orElseSucceed(() => null),
  );

  /**
   * An own bot on a cloud computer goes through the console (11.11), so a
   * sleeping computer wakes when someone writes to it. Before the switch,
   * one direct `getUpdates` with the current offset confirms to Telegram
   * what was already handled — otherwise Telegram would hand the last batch
   * to the console's webhook again and the assistant would answer it twice.
   * If that call brings anything new, the normal poll takes it and the
   * switch waits for a quiet cycle.
   */
  const switchOwnBotIfDue = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    runtime: BotRuntime,
  ) =>
    Effect.gen(function* () {
      const token = config.botToken;
      const nowMs = Date.now();
      if (
        !OwnBotRelay.isOwnBotToken(token) ||
        ownBotRelay(token) !== null ||
        !OwnBotRelay.attemptDue(token, nowMs)
      ) {
        return;
      }
      const identity = yield* machineIdentity;
      if (identity === null) {
        // A laptop or a BYO machine: Telegram directly, as always.
        OwnBotRelay.defer(token, nowMs, OwnBotRelay.OWN_BOT_RETRY_WHEN_OFF_MS);
        return;
      }
      const state = yield* connectorRepository
        .getState(connectorKey(projectId))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const persisted = Option.isSome(state) ? state.value : null;
      // On the relay before a restart: the console holds the webhook, there
      // is nothing to confirm to Telegram (and a direct call would get 409).
      const wasOnRelay = persisted?.credentialFingerprint === ownRelayFingerprint(token);
      if (!wasOnRelay) {
        // First sighting in this process: the runtime starts on Telegram's
        // stream first and replays what a previous run received but never
        // settled — the switch resets that state. Next cycle.
        if (runtime.botToken !== token) return;
        const confirm = yield* fetchJson(
          telegramApi(token, "getUpdates") +
            `?timeout=0&limit=1&offset=${runtime.offset}&allowed_updates=${encodeURIComponent(JSON.stringify(TELEGRAM_ALLOWED_UPDATES))}`,
        ).pipe(Effect.orElseSucceed(() => null));
        if (confirm === null) return; // network: the normal poll reports it
        if (confirm.ok === true) {
          // Something new: the normal poll takes it, the switch waits.
          if (Array.isArray(confirm.result) && confirm.result.length > 0) return;
        } else if (!OwnBotRelay.isWebhookConflict(confirm.error_code, confirm.description)) {
          // A bad token or another poller: the normal poll reports it.
          OwnBotRelay.defer(token, nowMs, OwnBotRelay.OWN_BOT_RETRY_AFTER_ERROR_MS);
          return;
        }
      }
      const outcome = yield* OwnBotRelay.register({
        identity,
        botToken: token,
        allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
        nowMs,
      });
      if (outcome.kind === "registered") {
        yield* Effect.logInfo("telegram own bot goes through Uno now").pipe(
          Effect.annotateLogs({ projectId, botUsername: outcome.botUsername }),
        );
      } else {
        yield* Effect.logInfo("telegram own bot stays on api.telegram.org").pipe(
          Effect.annotateLogs({ projectId, outcome }),
        );
      }
    });

  /**
   * After a failed Bot-API answer: the relay this bot talked through is gone
   * (401 from the console's mirror — moved to another computer or dropped),
   * or Telegram refuses a direct poll because a webhook holds the bot (409 —
   * ours, left from before a restart or a turned-off rollout). Returns true
   * when the transport changed or a fix was asked for.
   */
  const healOwnBotTransport = (
    projectId: ProjectId,
    config: ManagerTelegramConnectorConfig,
    answer: { readonly error_code?: number | undefined; readonly description?: string | undefined },
  ) =>
    Effect.gen(function* () {
      const token = config.botToken;
      if (!OwnBotRelay.isOwnBotToken(token)) return false;
      const nowMs = Date.now();
      if (ownBotRelay(token) !== null) {
        if (answer.error_code !== 401) return false;
        OwnBotRelay.dropRelay(token, nowMs);
        yield* Effect.logWarning("telegram own bot relay is gone; back to api.telegram.org").pipe(
          Effect.annotateLogs({ projectId }),
        );
        return true;
      }
      if (!OwnBotRelay.isWebhookConflict(answer.error_code, answer.description)) return false;
      const identity = yield* machineIdentity;
      if (identity === null) return false;
      // A webhook we may own blocks the direct poll: re-register (it is this
      // computer's bot) — or, if Uno doesn't take own bots now, let it go.
      if (OwnBotRelay.attemptDue(token, nowMs)) {
        const outcome = yield* OwnBotRelay.register({
          identity,
          botToken: token,
          allowedUpdates: TELEGRAM_ALLOWED_UPDATES,
          nowMs,
        });
        if (outcome.kind === "registered") return true;
      }
      if (!OwnBotRelay.lastAnsweredOff(token)) return false;
      return yield* OwnBotRelay.releaseBlockingWebhook({ identity, botToken: token, nowMs });
    });

  const pollConnector = (projectId: ProjectId, config: ManagerTelegramConnectorConfig) =>
    Effect.gen(function* () {
      let runtime = yield* getRuntime(projectId);
      yield* switchOwnBotIfDue(projectId, config, runtime);
      if (
        runtime.botToken !== config.botToken ||
        runtime.fingerprint !== credentialFingerprint(config.botToken)
      ) {
        yield* initializeRuntime(projectId, config);
        runtime = yield* getRuntime(projectId);
      }
      if (isBackingOff(runtime.health, Date.now())) {
        return;
      }

      if (runtime.botUsername === null) {
        const me = yield* fetchJson(telegramApi(config.botToken, "getMe"));
        if (me.ok !== true) {
          if (yield* healOwnBotTransport(projectId, config, me)) return;
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
          `?timeout=${POLL_TIMEOUT_SECONDS}&offset=${runtime.offset}&allowed_updates=${encodeURIComponent(JSON.stringify(TELEGRAM_ALLOWED_UPDATES))}`,
        // Bounded, and dropped at once when the computer wakes from economy
        // sleep: the message that woke it is waiting in the relay queue.
        { signal: longPollSignal((POLL_TIMEOUT_SECONDS + 15) * 1000) },
      );
      if (response.ok !== true) {
        if (yield* healOwnBotTransport(projectId, config, response)) return;
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

  // One-time (per daemon start) re-pointing of personal chats linked before
  // 0.0.86 to the main conversation — see `telegramPersonalChats.ts`.
  // Retried every cycle until the main conversation exists (the assistant
  // bootstrap creates it in the background); a failure is logged once and
  // not retried — routing sends personal chats to the main conversation
  // anyway, the migration only makes it stick in the bindings.
  const personalChatsMigratedRef = yield* Ref.make(false);
  const migratePersonalChatsOnce = Effect.gen(function* () {
    if (yield* Ref.get(personalChatsMigratedRef)) return;
    const result = yield* migratePersonalTelegramChats({
      connectors: connectorRepository,
      bindings: bindingRepository,
      // Archived still counts: the assistant bootstrap brings it back.
      findMainThreadId: projectionSnapshotQuery
        .getShellSnapshot()
        .pipe(Effect.map((snapshot) => findMarkedAssistantChat(snapshot.threads)?.id ?? null)),
      nowIso: new Date().toISOString(),
    });
    if (result.status === "no-main-conversation") return;
    yield* Ref.set(personalChatsMigratedRef, true);
    if (result.status === "done" && result.migrated.length > 0) {
      yield* Effect.logInfo("telegram personal chats moved to the main conversation").pipe(
        Effect.annotateLogs({
          mainThreadId: result.mainThreadId,
          chats: result.migrated.map((step) => ({
            chatId: step.chatId,
            previousTarget: step.previousTarget ?? "assistant (unbound)",
          })),
        }),
      );
    }
  }).pipe(
    Effect.catch((cause) =>
      Ref.set(personalChatsMigratedRef, true).pipe(
        Effect.andThen(
          Effect.logWarning("telegram personal chat migration failed").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
      ),
    ),
  );

  // An own bot that went through the console and is no longer polled here
  // (assistant disconnected, bot swapped, moved to another computer): let the
  // console drop its webhook, or it keeps queueing — and waking this
  // computer — for nobody. Once per start also the bots the console still
  // routes here from before a restart (this process's map starts empty).
  const ownBotsCheckedAfterStartRef = yield* Ref.make(false);
  const releaseOwnBotsNotInUse = (polledTokens: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const polled = new Set(polledTokens);
      const gone = ownBotRelayTokens().filter((token) => !polled.has(token));
      const checkedAfterStart = yield* Ref.get(ownBotsCheckedAfterStartRef);
      if (gone.length === 0 && checkedAfterStart) return;
      const identity = yield* machineIdentity;
      if (identity === null) {
        yield* Ref.set(ownBotsCheckedAfterStartRef, true);
        return;
      }
      for (const token of gone) {
        const released = yield* OwnBotRelay.release({ identity, botToken: token });
        yield* Effect.logInfo("telegram own bot released from Uno's relay").pipe(
          Effect.annotateLogs({ botId: OwnBotRelay.ownBotIdOf(token), released }),
        );
      }
      if (!checkedAfterStart) {
        yield* Ref.set(ownBotsCheckedAfterStartRef, true);
        const keep = new Set(
          polledTokens.flatMap((token) => {
            const id = OwnBotRelay.isOwnBotToken(token) ? OwnBotRelay.ownBotIdOf(token) : null;
            return id === null ? [] : [id];
          }),
        );
        const released = yield* OwnBotRelay.releaseUnused({ identity, keepBotIds: keep });
        if (released.length > 0) {
          yield* Effect.logInfo("telegram own bots no assistant here uses were released").pipe(
            Effect.annotateLogs({ botIds: released }),
          );
        }
      }
    });

  const pollCycle = Effect.gen(function* () {
    yield* migratePersonalChatsOnce;
    const records = yield* connectorRepository
      .listByKind("telegram")
      .pipe(Effect.orElseSucceed(() => []));
    const enabled = records.flatMap((record) => {
      const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(record.config);
      // A routed row (`unoroute:`) is no poll source: its holder polls.
      return decoded._tag === "Success" &&
        decoded.value.enabled &&
        parseRouteCredential(decoded.value.botToken) === null
        ? [{ projectId: record.projectId, config: decoded.value }]
        : [];
    });
    yield* releaseOwnBotsNotInUse(enabled.map(({ config }) => config.botToken));
    if (enabled.length === 0) {
      yield* Effect.sleep(IDLE_RECHECK);
      return;
    }
    yield* pruneInboxIfDue;
    yield* flushIdleQuizzes;
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
      const via = yield* resolveSendRow(input.projectId, decoded.value);
      if (via === null) {
        yield* Effect.logWarning("telegram push skipped: the shared bot's holder is gone").pipe(
          Effect.annotateLogs({ projectId: input.projectId }),
        );
        return false;
      }
      return yield* sendTelegramText(
        via.projectId,
        via.botToken,
        input.chatId,
        input.text.slice(0, TELEGRAM_MESSAGE_LIMIT),
      ).pipe(Effect.map((resp) => resp.ok));
    });

  yield* Effect.forkScoped(Effect.forever(pollCycle));

  const getRuntimeStatus: ManagerTelegramServiceShape["getRuntimeStatus"] = (requested) =>
    Effect.gen(function* () {
      // A routed row has no poller of its own: it shows the holder's bot.
      const row = yield* readRow(requested);
      const holder = row === null ? null : parseRouteCredential(row.botToken);
      const projectId = holder === null ? requested : ProjectId.make(holder);
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
      const ownToken =
        decoded !== null && decoded._tag === "Success" ? decoded.value.botToken : null;
      // A routed row's code goes through its holder's relay: the holder's
      // poller sees `/start <code>` and links the chat to this assistant.
      const via =
        decoded !== null && decoded._tag === "Success"
          ? yield* resolveSendRow(projectId, decoded.value)
          : null;
      const botToken = via?.botToken ?? ownToken;
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
      const runtime = yield* getRuntime(via?.projectId ?? projectId);
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
      const via = yield* resolveSendRow(input.projectId, config);
      if (via === null) return [];
      return yield* Effect.forEach(
        config.allowedChatIds,
        (chatId) =>
          sendTelegramText(via.projectId, via.botToken, chatId, input.text).pipe(
            Effect.map((result) => ({
              chatId,
              ok: result.ok,
              error: result.ok ? null : (result.description ?? "Telegram refused the message."),
            })),
          ),
        { concurrency: 2 },
      );
    });

  const enqueueSystemTurn: ManagerTelegramServiceShape["enqueueSystemTurn"] = (input) =>
    replies
      .enqueueSystemTurn(input)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("telegram system turn could not be queued").pipe(
            Effect.annotateLogs({ threadId: input.from.threadId, cause }),
            Effect.as("failed" as const),
          ),
        ),
      );

  const groups: ManagerTelegramServiceShape["groups"] = (projectId) =>
    Effect.gen(function* () {
      const row = yield* readRow(projectId);
      if (row === null) {
        return { supported: true, botUsername: null, groups: [], pending: [] };
      }
      // Uno's shared bot (held here or routed through another assistant)
      // only takes private chats.
      const supported = !isRelayCredential(row.botToken) && !isRouteCredential(row.botToken);
      const directory = yield* Ref.get(groupsRef);
      return telegramGroupsView({
        config: row,
        seen: supported ? (directory.connectors[projectId] ?? []) : [],
        botUsername: (yield* getRuntime(projectId)).botUsername,
        supported,
      });
    });

  const setGroupAccess: ManagerTelegramServiceShape["setGroupAccess"] = (input) =>
    Effect.gen(function* () {
      const row = yield* readRow(input.projectId);
      if (row === null) {
        return { ok: false as const, error: "This assistant has no Telegram bot yet." };
      }
      if (isRelayCredential(row.botToken) || isRouteCredential(row.botToken)) {
        return {
          ok: false as const,
          error:
            "Groups need the assistant's own bot: Uno's shared bot only answers in private chats.",
        };
      }
      const change = withTelegramGroupAccess(row, input);
      if (!change.ok) return { ok: false as const, error: change.error };
      const saved = yield* connectorRepository
        .upsert({
          projectId: input.projectId,
          kind: "telegram",
          config: change.config,
          updatedAt: new Date().toISOString(),
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (!saved) return { ok: false as const, error: "Could not save the group's settings." };
      yield* Effect.logInfo("telegram group access changed").pipe(
        Effect.annotateLogs({
          projectId: input.projectId,
          chatId: input.chatId,
          members: input.members,
        }),
      );
      return { ok: true as const, result: yield* groups(input.projectId) };
    });

  const updateWidget: ManagerTelegramServiceShape["updateWidget"] = (input) =>
    Effect.gen(function* () {
      const config = yield* readRow(input.projectId);
      if (config === null || !config.enabled) {
        return { ok: false, error: "Telegram is not connected." };
      }
      const via = yield* resolveSendRow(input.projectId, config);
      if (via === null) return { ok: false, error: "Telegram is not connected." };
      const widget = lastAgentWidget(yield* Ref.get(buttonsRef), {
        connectorProjectId: via.projectId,
        chatId: input.chatId,
        threadId: input.threadId,
        nowMs: Date.now(),
      });
      if (widget === null) {
        return {
          ok: false,
          error:
            "This chat has no widget in the person's Telegram to update: send one with messenger_send widget first (they can be updated for 7 days).",
        };
      }
      const answer = yield* callBotJson(via.botToken, "editMessageWidgetData", {
        chat_id: input.chatId,
        message_id: widget.messageId,
        chat_data: input.state,
      });
      if (answer.ok === true) return { ok: true, error: null };
      yield* Effect.logInfo("telegram widget update refused").pipe(
        Effect.annotateLogs({ chatId: input.chatId, description: answer.description }),
      );
      return {
        ok: false,
        error: `Telegram refused the update: ${answer.description ?? "no answer"}.`,
      };
    });

  return {
    getRuntimeStatus,
    sendText,
    sendRich,
    sendCard,
    updateWidget,
    retireRequestButtons,
    startPairing,
    sendTestMessage,
    enqueueSystemTurn,
    groups,
    setGroupAccess,
  } satisfies ManagerTelegramServiceShape;
});

export const ManagerTelegramServiceLive = Layer.effect(
  ManagerTelegramService,
  makeTelegramConnector,
).pipe(
  Layer.provide(
    Layer.mergeAll(ProjectionTurnRepositoryLive, ManagerConnectorPendingReplyRepositoryLive),
  ),
);
