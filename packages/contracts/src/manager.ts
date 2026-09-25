/**
 * Manager agent contracts — the capability-gated tool layer that lets an
 * external "manager brain" (Hermes sidecar today, native driver later)
 * observe and steer orchestration threads.
 *
 * Security model: the brain is always untrusted. Scopes, project allowlists,
 * budgets, and the proposal/approval lifecycle are enforced daemon-side in
 * `apps/server/src/manager/`; these schemas are the single source of truth
 * for both the internal Effect services and the MCP tool surface.
 */
import { Effect, Schema } from "effect";

import {
  ApprovalRequestId,
  IsoDateTime,
  ManagerProposalId,
  ManagerTokenId,
  CommandId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationMessageRole,
  OrchestrationSessionStatus,
  ProviderApprovalDecision,
  RuntimeMode,
} from "./orchestration.ts";

// ===============================
// Scopes & capability tokens
// ===============================

export const ManagerScope = Schema.Literals([
  "threads:read",
  "threads:write",
  "threads:approve",
  "manager:memory",
]);
export type ManagerScope = typeof ManagerScope.Type;

/**
 * Sliding-window action budgets per capability token. Enforced daemon-side so
 * a prompt-injected brain cannot talk its way past them. This is the loop
 * economics guardrail: runaway autonomous loops hit the budget, not the wallet.
 */
export const ManagerTokenBudget = Schema.Struct({
  maxWriteActionsPerHour: PositiveInt,
  maxTurnsPerDay: PositiveInt,
});
export type ManagerTokenBudget = typeof ManagerTokenBudget.Type;

export const DEFAULT_MANAGER_TOKEN_BUDGET: ManagerTokenBudget = {
  maxWriteActionsPerHour: 10,
  maxTurnsPerDay: 40,
};

export const ManagerProjectAllowlist = Schema.Union([
  Schema.Literal("all"),
  Schema.Array(ProjectId),
]);
export type ManagerProjectAllowlist = typeof ManagerProjectAllowlist.Type;

/**
 * Public descriptor of a manager capability token. The bearer secret is shown
 * once at creation and only its hash is persisted.
 *
 * `autoApprove: true` makes write tools execute immediately (the proposal is
 * still recorded, resolved as `auto:<tokenId>`, so the audit trail stays
 * complete). Intended for the in-app assistant where the owner is present;
 * external / messenger-facing tokens should keep it off.
 */
export const ManagerCapabilityTokenDescriptor = Schema.Struct({
  tokenId: ManagerTokenId,
  label: TrimmedNonEmptyString,
  scopes: Schema.Array(ManagerScope),
  projectAllowlist: ManagerProjectAllowlist,
  budget: Schema.NullOr(ManagerTokenBudget),
  autoApprove: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  createdAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type ManagerCapabilityTokenDescriptor = typeof ManagerCapabilityTokenDescriptor.Type;

export const ManagerCreateTokenInput = Schema.Struct({
  label: TrimmedNonEmptyString,
  scopes: Schema.Array(ManagerScope),
  projectAllowlist: ManagerProjectAllowlist,
  budget: Schema.optional(Schema.NullOr(ManagerTokenBudget)),
  autoApprove: Schema.optional(Schema.Boolean),
});
export type ManagerCreateTokenInput = typeof ManagerCreateTokenInput.Type;

// ===============================
// In-app assistant
// ===============================

/**
 * The assistant's home project: a dedicated workspace whose threads are the
 * assistant chats. Clients render it as the "Assistant" sidebar section
 * instead of a regular project.
 */
export const ASSISTANT_PROJECT_ID = ProjectId.make("assistant-home");
export const ASSISTANT_TOKEN_LABEL = "assistant-inapp";

/**
 * Assistants are projects whose id carries this prefix. `assistant-home` is
 * the default one; additional assistants (each with its own permissions,
 * allowed projects, and connectors) follow the same convention.
 */
export const ASSISTANT_PROJECT_ID_PREFIX = "assistant-";
export const isAssistantProjectId = (projectId: string): boolean =>
  projectId.startsWith(ASSISTANT_PROJECT_ID_PREFIX);

/** Every assistant owns one capability token, identified by this label. */
export const assistantTokenLabel = (projectId: string): string => `assistant:${projectId}`;

/** Workspace files the settings UI may read/write for an assistant. */
export const ASSISTANT_EDITABLE_FILES = ["AGENTS.md", "NOTES.md", "ROUTING.md"] as const;
export const AssistantEditableFileName = Schema.Literals(ASSISTANT_EDITABLE_FILES);
export type AssistantEditableFileName = typeof AssistantEditableFileName.Type;

export const ManagerCreateAssistantInput = Schema.Struct({
  name: TrimmedNonEmptyString,
});
export type ManagerCreateAssistantInput = typeof ManagerCreateAssistantInput.Type;

/** Owner-editable access profile of the in-app assistant. */
export const ManagerAssistantAccessInput = Schema.Struct({
  projectAllowlist: ManagerProjectAllowlist,
  scopes: Schema.optional(Schema.Array(ManagerScope)),
  autoApprove: Schema.optional(Schema.Boolean),
});
export type ManagerAssistantAccessInput = typeof ManagerAssistantAccessInput.Type;

/**
 * When the assistant should react to an inbound message. Shared by every
 * connector kind (Telegram today, Slack next): a 1:1 chat always reacts; a
 * group/channel stays silent unless the bot is @-mentioned, replied to, or
 * called by one of `names` (fuzzy — "Антоха" also answers to "Антон"). The
 * enforcement lives in `apps/server/src/manager/addressing.ts`. Every field
 * carries a decoding default so connector rows saved before this block existed
 * keep decoding.
 */
export const ManagerConnectorAddressingConfig = Schema.Struct({
  /** Wake names / aliases the bot answers to, e.g. `["Антоха", "Антон"]`. */
  names: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Require an explicit address in groups/channels. Off = answer everything. */
  requireMentionInGroups: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /** Let the daemon run an LLM classifier when the cheap checks miss. */
  smartWake: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Seconds after a reply during which follow-ups need no re-addressing. */
  hotWindowSec: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type ManagerConnectorAddressingConfig = typeof ManagerConnectorAddressingConfig.Type;

/** The defaults applied to a connector with no explicit addressing block. */
export const DEFAULT_CONNECTOR_ADDRESSING: ManagerConnectorAddressingConfig = {
  names: [],
  requireMentionInGroups: true,
  smartWake: false,
  hotWindowSec: 0,
};

export const ManagerTelegramConnectorConfig = Schema.Struct({
  /**
   * The owner's bot token, or `unorelay:<tgr_…>` — Uno's shared bot, reached
   * through the console's Bot-API mirror. Never sent to clients.
   */
  botToken: TrimmedNonEmptyString,
  /** Personal user chat ids and/or group chat ids (as strings, may be negative for groups). */
  allowedChatIds: Schema.Array(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  /**
   * Harness+model used for Telegram-initiated assistant chats. Null falls
   * back to the assistant project's default — but an explicit choice here is
   * what saves you from Telegram spawning a harness you never authorized.
   */
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  /** When to react. Absent on legacy rows → connector applies the defaults. */
  addressing: Schema.optionalKey(ManagerConnectorAddressingConfig),
});
export type ManagerTelegramConnectorConfig = typeof ManagerTelegramConnectorConfig.Type;

/**
 * Slack connector config. Slack runs over Socket Mode, so it needs two tokens:
 * `botToken` (`xoxb-…`, calls the Web API) and `appToken` (`xapp-…`, opens the
 * event socket). Shares the addressing block with Telegram; the live poller
 * Layer is implemented separately.
 */
export const ManagerSlackConnectorConfig = Schema.Struct({
  /** `xoxb-…`, or `unorelay:<slr_…>` for Uno's Slack app relayed by the console. */
  botToken: TrimmedNonEmptyString,
  /** `xapp-…`; the literal `unorelay` in relay mode (no Socket Mode). */
  appToken: TrimmedNonEmptyString,
  /** Channel ids and/or DM ids the bot may act in. */
  allowedChannelIds: Schema.Array(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  defaultModelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  addressing: Schema.optionalKey(ManagerConnectorAddressingConfig),
});
export type ManagerSlackConnectorConfig = typeof ManagerSlackConnectorConfig.Type;

/**
 * Session key for a Slack conversation, stored as the connector `chat_id`.
 * Thread-first: a channel message opens a session keyed by its own `ts` (the
 * bot replies in that thread), replies within a thread reuse the parent's
 * `thread_ts`, and a DM keys on the channel alone. This is what stops a whole
 * channel from collapsing into one shared context.
 */
export const slackChatKey = (channelId: string, threadTs?: string | null): string =>
  threadTs !== undefined && threadTs !== null && threadTs.length > 0
    ? `${channelId}:${threadTs}`
    : channelId;

/** Inverse of {@link slackChatKey}: split a stored chat key back into its parts. */
export const parseSlackChatKey = (
  chatKey: string,
): { readonly channelId: string; readonly threadTs: string | null } => {
  const separator = chatKey.indexOf(":");
  if (separator === -1) {
    return { channelId: chatKey, threadTs: null };
  }
  const threadTs = chatKey.slice(separator + 1);
  return {
    channelId: chatKey.slice(0, separator),
    threadTs: threadTs.length > 0 ? threadTs : null,
  };
};

/**
 * Health of a connector's link to its provider, as the daemon last observed
 * it. Persisted, so it survives a restart and the UI can show "auth expired
 * since Tuesday" instead of a blank.
 *
 * - `connected`: the last poll succeeded.
 * - `reconnecting`: network-level failures; the poller backs off and retries.
 * - `auth_expired`: the provider rejected the token (Telegram 401/403).
 * - `delivery_failed`: an outbound message was rejected after retries.
 * - `provider_unavailable`: the provider answered but with a server-side
 *   error (5xx, rate limit, conflicting poller).
 */
export const ManagerConnectorHealthStatus = Schema.Literals([
  "connected",
  "reconnecting",
  "auth_expired",
  "delivery_failed",
  "provider_unavailable",
]);
export type ManagerConnectorHealthStatus = typeof ManagerConnectorHealthStatus.Type;

export const ManagerConnectorHealth = Schema.Struct({
  status: ManagerConnectorHealthStatus,
  lastOkAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  lastErrorAt: Schema.NullOr(Schema.String),
});
export type ManagerConnectorHealth = typeof ManagerConnectorHealth.Type;

/** Telegram connector as exposed to clients: token is never echoed back. */
export const ManagerTelegramConnectorStatus = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  allowedChatIds: Schema.Array(TrimmedNonEmptyString),
  botUsername: Schema.NullOr(TrimmedNonEmptyString),
  lastError: Schema.NullOr(Schema.String),
  /** Null until the poller has observed the connector at least once. */
  health: Schema.NullOr(ManagerConnectorHealth),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  /** Current addressing rules, echoed back so the settings UI can render them. */
  addressing: ManagerConnectorAddressingConfig,
  /**
   * True when the connector talks through Uno's shared bot (a console relay,
   * set up by "Connect with Uno's bot") instead of the owner's own bot.
   */
  shared: Schema.Boolean,
});
export type ManagerTelegramConnectorStatus = typeof ManagerTelegramConnectorStatus.Type;

/** Slack connector as exposed to clients: tokens are never echoed back. */
export const ManagerSlackConnectorStatus = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  allowedChannelIds: Schema.Array(TrimmedNonEmptyString),
  /** Resolved from `auth.test` once the socket connects. */
  botUserId: Schema.NullOr(TrimmedNonEmptyString),
  botUserName: Schema.NullOr(TrimmedNonEmptyString),
  lastError: Schema.NullOr(Schema.String),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  addressing: ManagerConnectorAddressingConfig,
  /**
   * True when the connector runs through Uno's Slack app ("Add to Slack",
   * events relayed by the console) instead of the owner's own tokens.
   */
  shared: Schema.Boolean,
});
export type ManagerSlackConnectorStatus = typeof ManagerSlackConnectorStatus.Type;

/**
 * `POST /api/manager/assistant/telegram/shared` — the connector was switched
 * to Uno's shared bot and a link code issued (`link` opens the bot with
 * `/start <code>`).
 */
export const ManagerTelegramSharedResult = Schema.Struct({
  code: TrimmedNonEmptyString,
  expiresAt: Schema.String,
  botUsername: Schema.NullOr(TrimmedNonEmptyString),
  link: Schema.NullOr(Schema.String),
});
export type ManagerTelegramSharedResult = typeof ManagerTelegramSharedResult.Type;

/** `POST /api/manager/assistant/slack/install` — where to send the person to add Uno's Slack app. */
export const ManagerSlackInstallStartResult = Schema.Struct({
  available: Schema.Boolean,
  authorizeUrl: Schema.NullOr(Schema.String),
});
export type ManagerSlackInstallStartResult = typeof ManagerSlackInstallStartResult.Type;

/** `GET /api/manager/assistant/slack/install` — the "Add to Slack" installation as the daemon sees it. */
export const ManagerSlackInstallStatus = Schema.Struct({
  available: Schema.Boolean,
  installed: Schema.Boolean,
  teamName: Schema.NullOr(Schema.String),
  botUserName: Schema.NullOr(Schema.String),
  /** The connector runs in relay mode and its event poller reached the console. */
  connected: Schema.Boolean,
});
export type ManagerSlackInstallStatus = typeof ManagerSlackInstallStatus.Type;

/**
 * Error codes of the shared-bot / Add-to-Slack routes, in `{ error }`:
 * `not_cloud_computer` (409, no machine token), `shared_bot_unavailable` /
 * `slack_app_unavailable` (503), `console_unreachable` / `console_error` (502).
 */
export const ManagerChannelSetupErrorCode = Schema.Literals([
  "not_cloud_computer",
  "shared_bot_unavailable",
  "slack_app_unavailable",
  "slack_not_installed",
  "console_unreachable",
  "console_error",
]);
export type ManagerChannelSetupErrorCode = typeof ManagerChannelSetupErrorCode.Type;

export const ManagerAssistantOverview = Schema.Struct({
  token: Schema.NullOr(ManagerCapabilityTokenDescriptor),
  telegram: ManagerTelegramConnectorStatus,
  slack: ManagerSlackConnectorStatus,
});
export type ManagerAssistantOverview = typeof ManagerAssistantOverview.Type;

// ===============================
// Connector bindings (chat → target)
// ===============================

/**
 * A chat connector is a transport, not a conversation partner (ADR
 * 2026-09-11). Each chat of a connector is bound to a target that receives
 * its messages and whose events it may be notified about:
 *
 * - `assistant`: the assistant project that owns the bot (the default when
 *   no binding row exists — today's behaviour);
 * - `project`: a regular project; the chat gets one thread there, created
 *   on the project's default model, never forced into full access;
 * - `thread`: one specific existing thread.
 */
export const ManagerConnectorBindingKind = Schema.Literals(["telegram", "slack"]);
export type ManagerConnectorBindingKind = typeof ManagerConnectorBindingKind.Type;

export const ManagerConnectorBindingTargetKind = Schema.Literals([
  "assistant",
  "project",
  "thread",
]);
export type ManagerConnectorBindingTargetKind = typeof ManagerConnectorBindingTargetKind.Type;

export const ManagerConnectorBindingTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("assistant"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type ManagerConnectorBindingTarget = typeof ManagerConnectorBindingTarget.Type;

export const ManagerConnectorBinding = Schema.Struct({
  kind: ManagerConnectorBindingKind,
  /** Telegram chat id / Slack chat key — the connector's own chat identifier. */
  chatId: TrimmedNonEmptyString,
  /** Assistant project whose connector (bot) carries this chat. */
  connectorProjectId: ProjectId,
  target: ManagerConnectorBindingTarget,
  /** Also push "turn completed" for the target (errors and approvals are always pushed). */
  notifyOnComplete: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type ManagerConnectorBinding = typeof ManagerConnectorBinding.Type;

/** Binding as listed for the settings UI: the target resolved to a human label. */
export const ManagerConnectorBindingView = Schema.Struct({
  ...ManagerConnectorBinding.fields,
  /** Project / thread title of the target; null when the target no longer exists. */
  targetLabel: Schema.NullOr(Schema.String),
});
export type ManagerConnectorBindingView = typeof ManagerConnectorBindingView.Type;

export const ManagerConnectorBindingsListResult = Schema.Struct({
  bindings: Schema.Array(ManagerConnectorBindingView),
});
export type ManagerConnectorBindingsListResult = typeof ManagerConnectorBindingsListResult.Type;

export const ManagerConnectorBindingUpsertInput = Schema.Struct({
  kind: ManagerConnectorBindingKind,
  chatId: TrimmedNonEmptyString,
  connectorProjectId: ProjectId,
  target: ManagerConnectorBindingTarget,
  notifyOnComplete: Schema.optional(Schema.Boolean),
});
export type ManagerConnectorBindingUpsertInput = typeof ManagerConnectorBindingUpsertInput.Type;

export const ManagerConnectorBindingRemoveInput = Schema.Struct({
  kind: ManagerConnectorBindingKind,
  chatId: TrimmedNonEmptyString,
});
export type ManagerConnectorBindingRemoveInput = typeof ManagerConnectorBindingRemoveInput.Type;

/**
 * `POST /api/channels/notify` — outbound message from a thread's harness (or
 * any software holding the bridge token) to the chat(s) bound to that
 * thread / project. `threadId` defaults to the thread the bridge token is
 * scoped to.
 */
export const ChannelNotifyKind = Schema.Literals(["info", "warning", "error"]);
export type ChannelNotifyKind = typeof ChannelNotifyKind.Type;

export const CHANNEL_NOTIFY_PATH = "/api/channels/notify";
export const CHANNEL_NOTIFY_MAX_TEXT_CHARS = 4_000;

export const ChannelNotifyInput = Schema.Struct({
  text: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  kind: Schema.optional(ChannelNotifyKind),
});
export type ChannelNotifyInput = typeof ChannelNotifyInput.Type;

export const ChannelNotifyResult = Schema.Struct({
  delivered: NonNegativeInt,
  chats: Schema.Array(
    Schema.Struct({
      kind: ManagerConnectorBindingKind,
      chatId: TrimmedNonEmptyString,
      delivered: Schema.Boolean,
    }),
  ),
});
export type ChannelNotifyResult = typeof ChannelNotifyResult.Type;

/** Defaults applied to a Slack connector that has no row yet. */
export const DEFAULT_SLACK_CONNECTOR_STATUS: ManagerSlackConnectorStatus = {
  configured: false,
  enabled: false,
  allowedChannelIds: [],
  botUserId: null,
  botUserName: null,
  lastError: null,
  defaultModelSelection: null,
  addressing: DEFAULT_CONNECTOR_ADDRESSING,
  shared: false,
};

export const ManagerAssistantSummary = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  token: Schema.NullOr(ManagerCapabilityTokenDescriptor),
  telegram: ManagerTelegramConnectorStatus,
  slack: ManagerSlackConnectorStatus,
  /** Names of skill files under the workspace `skills/` directory. */
  skills: Schema.Array(Schema.String),
});
export type ManagerAssistantSummary = typeof ManagerAssistantSummary.Type;

/** Returned once at creation time; `token` is the bearer secret. */
export const ManagerCreateTokenResult = Schema.Struct({
  descriptor: ManagerCapabilityTokenDescriptor,
  token: TrimmedNonEmptyString,
});
export type ManagerCreateTokenResult = typeof ManagerCreateTokenResult.Type;

// ===============================
// Proposed actions & proposals
// ===============================

export const ManagerProposedActionCreateThread = Schema.Struct({
  kind: Schema.Literal("create-thread"),
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: RuntimeMode,
});
export type ManagerProposedActionCreateThread = typeof ManagerProposedActionCreateThread.Type;

export const ManagerProposedActionSendTurn = Schema.Struct({
  kind: Schema.Literal("send-turn"),
  threadId: ThreadId,
  prompt: TrimmedNonEmptyString,
});
export type ManagerProposedActionSendTurn = typeof ManagerProposedActionSendTurn.Type;

export const ManagerProposedActionInterruptTurn = Schema.Struct({
  kind: Schema.Literal("interrupt-turn"),
  threadId: ThreadId,
});
export type ManagerProposedActionInterruptTurn = typeof ManagerProposedActionInterruptTurn.Type;

export const ManagerProposedActionRespondToRequest = Schema.Struct({
  kind: Schema.Literal("respond-to-request"),
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ManagerProposedActionRespondToRequest =
  typeof ManagerProposedActionRespondToRequest.Type;

export const ManagerProposedAction = Schema.Union([
  ManagerProposedActionCreateThread,
  ManagerProposedActionSendTurn,
  ManagerProposedActionInterruptTurn,
  ManagerProposedActionRespondToRequest,
]);
export type ManagerProposedAction = typeof ManagerProposedAction.Type;

export const ManagerProposalStatus = Schema.Literals(["pending", "approved", "denied", "expired"]);
export type ManagerProposalStatus = typeof ManagerProposalStatus.Type;

export const MANAGER_PROPOSAL_TTL_MINUTES = 30;

/**
 * A write action filed by the manager brain, awaiting resolution.
 *
 * The nonce is single-use and required to resolve a proposal through the MCP
 * surface; owner-session resolution (Electron UI / HTTP) does not need it.
 * `resolutionCommandIds` links the proposal to the orchestration commands it
 * dispatched on approval, tying the audit trail together with event origins.
 */
export const ManagerActionProposal = Schema.Struct({
  proposalId: ManagerProposalId,
  tokenId: ManagerTokenId,
  action: ManagerProposedAction,
  status: ManagerProposalStatus,
  nonce: TrimmedNonEmptyString,
  requestedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  resolvedBy: Schema.NullOr(TrimmedNonEmptyString),
  resolutionCommandIds: Schema.Array(CommandId),
});
export type ManagerActionProposal = typeof ManagerActionProposal.Type;

export const ManagerProposalDecision = Schema.Literals(["approved", "denied"]);
export type ManagerProposalDecision = typeof ManagerProposalDecision.Type;

// ===============================
// Tool inputs / outputs
// ===============================

export const ManagerThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
});
export type ManagerThreadSummary = typeof ManagerThreadSummary.Type;

export const ManagerListThreadsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type ManagerListThreadsInput = typeof ManagerListThreadsInput.Type;

export const ManagerProjectSummary = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
});
export type ManagerProjectSummary = typeof ManagerProjectSummary.Type;

export const ManagerListThreadsResult = Schema.Struct({
  projects: Schema.Array(ManagerProjectSummary),
  threads: Schema.Array(ManagerThreadSummary),
});
export type ManagerListThreadsResult = typeof ManagerListThreadsResult.Type;

export const ManagerGetThreadStatusInput = Schema.Struct({
  threadId: ThreadId,
});
export type ManagerGetThreadStatusInput = typeof ManagerGetThreadStatusInput.Type;

export const ManagerPendingApprovalSummary = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  createdAt: IsoDateTime,
});
export type ManagerPendingApprovalSummary = typeof ManagerPendingApprovalSummary.Type;

export const ManagerGetThreadStatusResult = Schema.Struct({
  thread: ManagerThreadSummary,
  pendingApprovals: Schema.Array(ManagerPendingApprovalSummary),
});
export type ManagerGetThreadStatusResult = typeof ManagerGetThreadStatusResult.Type;

export const MANAGER_READ_THREAD_DETAIL_DEFAULT_MESSAGES = 20;
export const MANAGER_READ_THREAD_DETAIL_MAX_MESSAGES = 50;
export const MANAGER_READ_THREAD_DETAIL_MAX_MESSAGE_CHARS = 4_000;

export const ManagerReadThreadDetailInput = Schema.Struct({
  threadId: ThreadId,
  lastMessages: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(MANAGER_READ_THREAD_DETAIL_MAX_MESSAGES)),
  ),
});
export type ManagerReadThreadDetailInput = typeof ManagerReadThreadDetailInput.Type;

/**
 * Thread message content returned to the brain. `text` is attacker-influenced
 * data (a child agent's output); the tool layer wraps it in
 * `<untrusted_thread_output>` delimiters and the manager skill must treat it
 * as data, never as instructions.
 */
export const ManagerThreadMessage = Schema.Struct({
  role: OrchestrationMessageRole,
  text: Schema.String,
  createdAt: IsoDateTime,
  truncated: Schema.Boolean,
});
export type ManagerThreadMessage = typeof ManagerThreadMessage.Type;

export const ManagerReadThreadDetailResult = Schema.Struct({
  thread: ManagerThreadSummary,
  messages: Schema.Array(ManagerThreadMessage),
  omittedMessageCount: NonNegativeInt,
});
export type ManagerReadThreadDetailResult = typeof ManagerReadThreadDetailResult.Type;

export const ManagerListPendingApprovalsResult = Schema.Struct({
  approvals: Schema.Array(ManagerPendingApprovalSummary),
});
export type ManagerListPendingApprovalsResult = typeof ManagerListPendingApprovalsResult.Type;

// Write tool inputs mirror the proposed-action payloads minus the `kind` tag.

export const ManagerCreateThreadInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optional(RuntimeMode),
});
export type ManagerCreateThreadInput = typeof ManagerCreateThreadInput.Type;

export const ManagerSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  prompt: TrimmedNonEmptyString,
});
export type ManagerSendTurnInput = typeof ManagerSendTurnInput.Type;

export const ManagerInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
});
export type ManagerInterruptTurnInput = typeof ManagerInterruptTurnInput.Type;

export const ManagerRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ManagerRespondToRequestInput = typeof ManagerRespondToRequestInput.Type;

/**
 * Every write tool returns a proposal receipt: v1 never executes writes
 * inline. The `executed` branch exists for a future auto-approve tier.
 */
export const ManagerWriteReceipt = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("pending-approval"),
    proposalId: ManagerProposalId,
    nonce: TrimmedNonEmptyString,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("executed"),
    proposalId: ManagerProposalId,
    commandIds: Schema.Array(CommandId),
  }),
]);
export type ManagerWriteReceipt = typeof ManagerWriteReceipt.Type;

export const ManagerListProposalsInput = Schema.Struct({
  status: Schema.optional(ManagerProposalStatus),
});
export type ManagerListProposalsInput = typeof ManagerListProposalsInput.Type;

export const ManagerListProposalsResult = Schema.Struct({
  proposals: Schema.Array(ManagerActionProposal),
});
export type ManagerListProposalsResult = typeof ManagerListProposalsResult.Type;

export const ManagerResolveProposalInput = Schema.Struct({
  proposalId: ManagerProposalId,
  decision: ManagerProposalDecision,
  nonce: TrimmedNonEmptyString,
});
export type ManagerResolveProposalInput = typeof ManagerResolveProposalInput.Type;

export const ManagerResolveProposalResult = Schema.Struct({
  proposal: ManagerActionProposal,
});
export type ManagerResolveProposalResult = typeof ManagerResolveProposalResult.Type;

/** Owner-side resolution (Electron UI / HTTP route); no nonce required. */
export const ManagerOwnerResolveProposalInput = Schema.Struct({
  proposalId: ManagerProposalId,
  decision: ManagerProposalDecision,
});
export type ManagerOwnerResolveProposalInput = typeof ManagerOwnerResolveProposalInput.Type;

// ===============================
// Reminders
// ===============================

/**
 * A one-shot reminder: at `dueAt`, the daemon pushes `message` to a Telegram
 * chat. Unlike a manager reply, delivery is deterministic (the text is sent
 * verbatim by the scheduler, no LLM turn), and the row is durable — it
 * survives restarts and fires as soon as the daemon is running again if its
 * due time passed while it was down.
 */
export const ReminderStatus = Schema.Literals(["pending", "delivered", "failed", "cancelled"]);
export type ReminderStatus = typeof ReminderStatus.Type;

/** Which messenger delivers the reminder. Rows predating the field are Telegram. */
export const ReminderConnectorKind = Schema.Literals(["telegram", "slack"]);
export type ReminderConnectorKind = typeof ReminderConnectorKind.Type;

export const Reminder = Schema.Struct({
  reminderId: TrimmedNonEmptyString,
  projectId: ProjectId,
  /**
   * Delivery target within the connector: a Telegram chat id, or a Slack
   * channel id / `channel:thread_ts` chat key (thread reminders land in the
   * thread they were asked in).
   */
  chatId: TrimmedNonEmptyString,
  connector: ReminderConnectorKind.pipe(
    Schema.withDecodingDefault(Effect.succeed("telegram" as const)),
  ),
  message: TrimmedNonEmptyString,
  dueAt: IsoDateTime,
  status: ReminderStatus,
  createdAt: IsoDateTime,
  /** Origin of the reminder: `manager-token:<id>` or `owner`. */
  createdBy: TrimmedNonEmptyString,
  deliveredAt: Schema.NullOr(IsoDateTime),
  failureReason: Schema.NullOr(Schema.String),
});
export type Reminder = typeof Reminder.Type;

/** Guardrail: reject absurd delays so a typo can't schedule years out. */
export const MANAGER_REMINDER_MAX_DELAY_SECONDS = 60 * 60 * 24 * 30; // 30 days

export const ManagerCreateReminderInput = Schema.Struct({
  message: TrimmedNonEmptyString,
  /** Fire this many seconds from now. Mutually exclusive with `dueAt`. */
  dueInSeconds: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(MANAGER_REMINDER_MAX_DELAY_SECONDS)),
  ),
  /** Absolute ISO time to fire. Mutually exclusive with `dueInSeconds`. */
  dueAt: Schema.optional(IsoDateTime),
  /** Target project; defaults to the caller's Telegram-connected project. */
  projectId: Schema.optional(ProjectId),
  /** Target chat; defaults to that project's first allowlisted chat. */
  chatId: Schema.optional(TrimmedNonEmptyString),
  /**
   * Which messenger to deliver through. Default: the first configured
   * connector (Telegram wins when both are set up).
   */
  connector: Schema.optional(ReminderConnectorKind),
});
export type ManagerCreateReminderInput = typeof ManagerCreateReminderInput.Type;

export const ManagerCreateReminderResult = Schema.Struct({
  reminderId: TrimmedNonEmptyString,
  dueAt: IsoDateTime,
  chatId: TrimmedNonEmptyString,
});
export type ManagerCreateReminderResult = typeof ManagerCreateReminderResult.Type;

export const ManagerListRemindersInput = Schema.Struct({
  /** Include delivered/failed/cancelled reminders too (default: only pending). */
  includeInactive: Schema.optional(Schema.Boolean),
});
export type ManagerListRemindersInput = typeof ManagerListRemindersInput.Type;

export const ManagerListRemindersResult = Schema.Struct({
  reminders: Schema.Array(Reminder),
});
export type ManagerListRemindersResult = typeof ManagerListRemindersResult.Type;

export const ManagerCancelReminderInput = Schema.Struct({
  reminderId: TrimmedNonEmptyString,
});
export type ManagerCancelReminderInput = typeof ManagerCancelReminderInput.Type;

export const ManagerCancelReminderResult = Schema.Struct({
  cancelled: Schema.Boolean,
});
export type ManagerCancelReminderResult = typeof ManagerCancelReminderResult.Type;
