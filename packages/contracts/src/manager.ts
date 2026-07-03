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
});
export type ManagerTelegramConnectorConfig = typeof ManagerTelegramConnectorConfig.Type;

/** Telegram connector as exposed to clients: token is never echoed back. */
export const ManagerTelegramConnectorStatus = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  allowedChatIds: Schema.Array(TrimmedNonEmptyString),
  botUsername: Schema.NullOr(TrimmedNonEmptyString),
  lastError: Schema.NullOr(Schema.String),
  defaultModelSelection: Schema.NullOr(ModelSelection),
});
export type ManagerTelegramConnectorStatus = typeof ManagerTelegramConnectorStatus.Type;

export const ManagerAssistantOverview = Schema.Struct({
  token: Schema.NullOr(ManagerCapabilityTokenDescriptor),
  telegram: ManagerTelegramConnectorStatus,
});
export type ManagerAssistantOverview = typeof ManagerAssistantOverview.Type;

export const ManagerAssistantSummary = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  token: Schema.NullOr(ManagerCapabilityTokenDescriptor),
  telegram: ManagerTelegramConnectorStatus,
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
