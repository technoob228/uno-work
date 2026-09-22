/**
 * ManagerToolService - The capability-gated tool surface for the manager
 * brain (Hermes sidecar via MCP today, native driver later).
 *
 * Every method takes a `ManagerCaller` — the resolved capability token — as
 * its first argument and enforces scopes, project allowlists, and budgets
 * daemon-side. Write methods never execute directly: they file proposals that
 * the approval flow resolves.
 *
 * @module ManagerToolService
 */
import type {
  ManagerCancelReminderInput,
  ManagerCancelReminderResult,
  ManagerCreateReminderInput,
  ManagerCreateReminderResult,
  ManagerCreateThreadInput,
  ManagerGetThreadStatusInput,
  ManagerGetThreadStatusResult,
  ManagerInterruptTurnInput,
  ManagerListPendingApprovalsResult,
  ManagerListProposalsInput,
  ManagerListProposalsResult,
  ManagerListRemindersInput,
  ManagerListRemindersResult,
  ManagerListThreadsInput,
  ManagerListThreadsResult,
  ManagerProjectAllowlist,
  ManagerReadThreadDetailInput,
  ManagerReadThreadDetailResult,
  ManagerResolveProposalInput,
  ManagerResolveProposalResult,
  ManagerRespondToRequestInput,
  ManagerScope,
  ManagerSendTurnInput,
  ManagerTokenBudget,
  ManagerTokenId,
  ManagerWaitForThreadInput,
  ManagerWaitForThreadResult,
  ManagerWaitForThreadsInput,
  ManagerWaitForThreadsResult,
  ManagerWriteReceipt,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ManagerToolError } from "../Errors.ts";

/** The resolved capability token on whose behalf a tool call runs. */
export interface ManagerCaller {
  readonly tokenId: ManagerTokenId;
  readonly scopes: ReadonlyArray<ManagerScope>;
  readonly projectAllowlist: ManagerProjectAllowlist;
  readonly budget: ManagerTokenBudget | null;
  /** Write tools execute immediately (still audited as auto-resolved proposals). */
  readonly autoApprove: boolean;
}

export interface ManagerToolServiceShape {
  readonly listThreads: (
    caller: ManagerCaller,
    input: ManagerListThreadsInput,
  ) => Effect.Effect<ManagerListThreadsResult, ManagerToolError>;
  readonly getThreadStatus: (
    caller: ManagerCaller,
    input: ManagerGetThreadStatusInput,
  ) => Effect.Effect<ManagerGetThreadStatusResult, ManagerToolError>;
  /**
   * Block until the thread's current turn settles (completed / error /
   * interrupted / needs a human) or the timeout passes. Event-driven, with a
   * rare fallback poll; replaces `get_thread_status` polling loops.
   */
  readonly waitForThread: (
    caller: ManagerCaller,
    input: ManagerWaitForThreadInput,
  ) => Effect.Effect<ManagerWaitForThreadResult, ManagerToolError>;
  readonly waitForThreads: (
    caller: ManagerCaller,
    input: ManagerWaitForThreadsInput,
  ) => Effect.Effect<ManagerWaitForThreadsResult, ManagerToolError>;
  readonly readThreadDetail: (
    caller: ManagerCaller,
    input: ManagerReadThreadDetailInput,
  ) => Effect.Effect<ManagerReadThreadDetailResult, ManagerToolError>;
  readonly listPendingApprovals: (
    caller: ManagerCaller,
  ) => Effect.Effect<ManagerListPendingApprovalsResult, ManagerToolError>;
  readonly createThread: (
    caller: ManagerCaller,
    input: ManagerCreateThreadInput,
  ) => Effect.Effect<ManagerWriteReceipt, ManagerToolError>;
  readonly sendTurn: (
    caller: ManagerCaller,
    input: ManagerSendTurnInput,
  ) => Effect.Effect<ManagerWriteReceipt, ManagerToolError>;
  readonly interruptTurn: (
    caller: ManagerCaller,
    input: ManagerInterruptTurnInput,
  ) => Effect.Effect<ManagerWriteReceipt, ManagerToolError>;
  readonly respondToRequest: (
    caller: ManagerCaller,
    input: ManagerRespondToRequestInput,
  ) => Effect.Effect<ManagerWriteReceipt, ManagerToolError>;
  readonly listProposals: (
    caller: ManagerCaller,
    input: ManagerListProposalsInput,
  ) => Effect.Effect<ManagerListProposalsResult, ManagerToolError>;
  readonly resolveProposal: (
    caller: ManagerCaller,
    input: ManagerResolveProposalInput,
  ) => Effect.Effect<ManagerResolveProposalResult, ManagerToolError>;
  readonly createReminder: (
    caller: ManagerCaller,
    input: ManagerCreateReminderInput,
  ) => Effect.Effect<ManagerCreateReminderResult, ManagerToolError>;
  readonly listReminders: (
    caller: ManagerCaller,
    input: ManagerListRemindersInput,
  ) => Effect.Effect<ManagerListRemindersResult, ManagerToolError>;
  readonly cancelReminder: (
    caller: ManagerCaller,
    input: ManagerCancelReminderInput,
  ) => Effect.Effect<ManagerCancelReminderResult, ManagerToolError>;
}

export class ManagerToolService extends Context.Service<
  ManagerToolService,
  ManagerToolServiceShape
>()("t3/manager/Services/ManagerToolService") {}
