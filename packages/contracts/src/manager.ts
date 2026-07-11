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
  names: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Require an explicit address in groups/channels. Off = answer everything. */
  requireMentionInGroups: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  /** Let the daemon run an LLM classifier when the cheap checks miss. */
  smartWake: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Seconds after a reply during which follow-ups need no re-addressing. */
  hotWindowSec: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type ManagerConnectorAddressingConfig =
  typeof ManagerConnectorAddressingConfig.Type;

/** The defaults applied to a connector with no explicit addressing block. */
export const DEFAULT_CONNECTOR_ADDRESSING: ManagerConnectorAddressingConfig = {
  names: [],
  requireMentionInGroups: true,
  smartWake: false,
  hotWindowSec: 0,
};

export const ManagerTelegramConnectorConfig = Schema.Struct({
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
  botToken: TrimmedNonEmptyString,
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

/** Telegram connector as exposed to clients: token is never echoed back. */
export const ManagerTelegramConnectorStatus = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  allowedChatIds: Schema.Array(TrimmedNonEmptyString),
  botUsername: Schema.NullOr(TrimmedNonEmptyString),
  lastError: Schema.NullOr(Schema.String),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  /** Current addressing rules, echoed back so the settings UI can render them. */
  addressing: ManagerConnectorAddressingConfig,
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
});
export type ManagerSlackConnectorStatus = typeof ManagerSlackConnectorStatus.Type;

export const ManagerAssistantOverview = Schema.Struct({
  token: Schema.NullOr(ManagerCapabilityTokenDescriptor),
  telegram: ManagerTelegramConnectorStatus,
  slack: ManagerSlackConnectorStatus,
});
export type ManagerAssistantOverview = typeof ManagerAssistantOverview.Type;

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
export const ReminderStatus = Schema.Literals([
  "pending",
  "delivered",
  "failed",
  "cancelled",
]);
export type ReminderStatus = typeof ReminderStatus.Type;

export const Reminder = Schema.Struct({
  reminderId: TrimmedNonEmptyString,
  projectId: ProjectId,
  chatId: TrimmedNonEmptyString,
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
