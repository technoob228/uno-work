/**
 * ManagerApprovalService - Owns the proposal resolution lifecycle.
 *
 * Single resolution path for all surfaces: owner (Electron UI / HTTP, no
 * nonce) and manager brain (MCP `resolve_proposal`, nonce required — checked
 * by the tool layer before delegating here). On approval the stored action is
 * executed strictly through `OrchestrationEngineService.dispatch` with a
 * manager origin stamp, so it is event-sourced and visible in every client.
 *
 * @module ManagerApprovalService
 */
import type {
  ManagerActionProposal,
  ManagerProposalDecision,
  ManagerProposalId,
  ManagerProposalStatus,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ManagerToolError } from "../Errors.ts";
import type { ManagerRepositoryError } from "../../persistence/Errors.ts";

export interface ManagerApprovalServiceShape {
  /**
   * Transition a pending proposal and, on approval, execute its action.
   * `resolvedBy` is an audit label such as `owner:<sessionId>` or
   * `manager-token:<tokenId>`.
   */
  readonly resolve: (input: {
    readonly proposalId: ManagerProposalId;
    readonly decision: ManagerProposalDecision;
    readonly resolvedBy: string;
  }) => Effect.Effect<ManagerActionProposal, ManagerToolError>;
  /** Owner-facing list across all tokens. */
  readonly listAll: (input: {
    readonly status?: ManagerProposalStatus | undefined;
  }) => Effect.Effect<ReadonlyArray<ManagerActionProposal>, ManagerRepositoryError>;
  /** Transition stale pending proposals to expired. Also runs on a timer. */
  readonly expireStale: () => Effect.Effect<
    ReadonlyArray<ManagerProposalId>,
    ManagerRepositoryError
  >;
}

export class ManagerApprovalService extends Context.Service<
  ManagerApprovalService,
  ManagerApprovalServiceShape
>()("t3/manager/Services/ManagerApprovalService") {}
