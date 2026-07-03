/**
 * ManagerActionProposalRepository - Repository interface for manager write
 * proposals.
 *
 * Every write action filed by the manager brain lands here as a pending
 * proposal; execution happens only after resolution. The table doubles as the
 * budget source of truth: sliding-window counts run over `requested_at` /
 * `resolved_at`.
 *
 * @module ManagerActionProposalRepository
 */
import {
  ManagerActionProposal,
  ManagerProposalId,
  ManagerProposalStatus,
  ManagerTokenId,
  CommandId,
} from "@t3tools/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ManagerRepositoryError } from "../Errors.ts";

export const CreateManagerProposalInput = ManagerActionProposal;
export type CreateManagerProposalInput = typeof CreateManagerProposalInput.Type;

export const GetManagerProposalByIdInput = Schema.Struct({
  proposalId: ManagerProposalId,
});
export type GetManagerProposalByIdInput = typeof GetManagerProposalByIdInput.Type;

export const ListManagerProposalsInput = Schema.Struct({
  status: Schema.optional(ManagerProposalStatus),
  tokenId: Schema.optional(ManagerTokenId),
});
export type ListManagerProposalsInput = typeof ListManagerProposalsInput.Type;

/**
 * Conditional transition pending -> approved|denied. Returns false when the
 * proposal is not pending anymore (single-use guarantee lives in SQL, not in
 * application code).
 */
export const ResolveManagerProposalRowInput = Schema.Struct({
  proposalId: ManagerProposalId,
  status: Schema.Literals(["approved", "denied"]),
  resolvedAt: Schema.String,
  resolvedBy: Schema.String,
});
export type ResolveManagerProposalRowInput = typeof ResolveManagerProposalRowInput.Type;

export const SetManagerProposalResolutionCommandsInput = Schema.Struct({
  proposalId: ManagerProposalId,
  resolutionCommandIds: Schema.Array(CommandId),
});
export type SetManagerProposalResolutionCommandsInput =
  typeof SetManagerProposalResolutionCommandsInput.Type;

export const ExpireManagerProposalsInput = Schema.Struct({
  now: Schema.String,
});
export type ExpireManagerProposalsInput = typeof ExpireManagerProposalsInput.Type;

export const CountManagerProposalsSinceInput = Schema.Struct({
  tokenId: ManagerTokenId,
  requestedAfter: Schema.String,
});
export type CountManagerProposalsSinceInput = typeof CountManagerProposalsSinceInput.Type;

export const CountApprovedTurnProposalsSinceInput = Schema.Struct({
  tokenId: ManagerTokenId,
  resolvedAfter: Schema.String,
});
export type CountApprovedTurnProposalsSinceInput = typeof CountApprovedTurnProposalsSinceInput.Type;

export interface ManagerActionProposalRepositoryShape {
  readonly create: (
    input: CreateManagerProposalInput,
  ) => Effect.Effect<void, ManagerRepositoryError>;
  readonly getById: (
    input: GetManagerProposalByIdInput,
  ) => Effect.Effect<Option.Option<ManagerActionProposal>, ManagerRepositoryError>;
  readonly list: (
    input: ListManagerProposalsInput,
  ) => Effect.Effect<ReadonlyArray<ManagerActionProposal>, ManagerRepositoryError>;
  readonly resolve: (
    input: ResolveManagerProposalRowInput,
  ) => Effect.Effect<boolean, ManagerRepositoryError>;
  readonly setResolutionCommands: (
    input: SetManagerProposalResolutionCommandsInput,
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /** Transition all pending proposals with expires_at <= now to expired. */
  readonly expireStale: (
    input: ExpireManagerProposalsInput,
  ) => Effect.Effect<ReadonlyArray<ManagerProposalId>, ManagerRepositoryError>;
  /** Budget window: proposals filed by a token after the given instant. */
  readonly countRequestedSince: (
    input: CountManagerProposalsSinceInput,
  ) => Effect.Effect<number, ManagerRepositoryError>;
  /** Budget window: approved turn-starting proposals (create-thread/send-turn). */
  readonly countApprovedTurnsSince: (
    input: CountApprovedTurnProposalsSinceInput,
  ) => Effect.Effect<number, ManagerRepositoryError>;
}

export class ManagerActionProposalRepository extends Context.Service<
  ManagerActionProposalRepository,
  ManagerActionProposalRepositoryShape
>()("t3/persistence/Services/ManagerActionProposals/ManagerActionProposalRepository") {}
