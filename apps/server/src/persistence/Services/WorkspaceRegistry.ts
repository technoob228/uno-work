/**
 * WorkspaceRegistryRepository — durable state for the workspace a daemon
 * belongs to: its machines, grants, claims, pending requests and the
 * instruction layers agents read.
 *
 * Every mutation bumps `epoch`. Readers compare epochs to tell "my view is
 * stale" from "nothing has changed" — the panel says that out loud, because a
 * silently stale registry looks exactly like a healthy one.
 *
 * @module WorkspaceRegistryRepository
 */
import type {
  WorkspaceClaim,
  WorkspaceGrant,
  WorkspaceIdentity,
  WorkspaceMachine,
  WorkspacePolicy,
  WorkspaceRequest,
  WorkspaceRequestStatus,
  WorkspaceState,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { ManagerRepositoryError } from "../Errors.ts";

export const EnsureWorkspaceInput = Schema.Struct({
  workspaceId: Schema.String,
  name: Schema.String,
  now: Schema.String,
});
export type EnsureWorkspaceInput = typeof EnsureWorkspaceInput.Type;

export const UpdateWorkspaceIdentityInput = Schema.Struct({
  name: Schema.optional(Schema.String),
  registryEnvironmentId: Schema.optional(Schema.NullOr(Schema.String)),
  unoAccountId: Schema.optional(Schema.NullOr(Schema.Number)),
  now: Schema.String,
});
export type UpdateWorkspaceIdentityInput = typeof UpdateWorkspaceIdentityInput.Type;

export const ClaimAcquireInput = Schema.Struct({
  claimKey: Schema.String,
  holderEnvironmentId: Schema.String,
  reason: Schema.String,
  now: Schema.String,
  expiresAt: Schema.String,
});
export type ClaimAcquireInput = typeof ClaimAcquireInput.Type;

/**
 * `taken` carries the current holder so the caller can say who has it rather
 * than only that the attempt failed.
 */
export type ClaimAcquireOutcome =
  | { readonly kind: "acquired"; readonly claim: WorkspaceClaim }
  | { readonly kind: "renewed"; readonly claim: WorkspaceClaim }
  | { readonly kind: "taken"; readonly claim: WorkspaceClaim };

export interface WorkspaceRegistryRepositoryShape {
  /** Creates the single identity row if missing; never overwrites an existing one. */
  readonly ensureWorkspace: (
    input: EnsureWorkspaceInput,
  ) => Effect.Effect<WorkspaceIdentity, ManagerRepositoryError>;
  readonly getIdentity: () => Effect.Effect<
    Option.Option<WorkspaceIdentity>,
    ManagerRepositoryError
  >;
  readonly updateIdentity: (
    input: UpdateWorkspaceIdentityInput,
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /** Full snapshot with expired claims and requests already filtered out. */
  readonly getState: (input: {
    readonly now: string;
  }) => Effect.Effect<WorkspaceState, ManagerRepositoryError>;
  readonly upsertMachine: (
    machine: WorkspaceMachine,
  ) => Effect.Effect<void, ManagerRepositoryError>;
  readonly removeMachine: (input: {
    readonly environmentId: string;
    readonly now: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
  /** Presence touch; does not bump the epoch — liveness is not a registry change. */
  readonly touchMachine: (input: {
    readonly environmentId: string;
    readonly lastSeenAt: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
  readonly setPolicy: (input: {
    readonly policy: WorkspacePolicy;
    readonly now: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
  readonly upsertGrant: (input: {
    readonly grant: WorkspaceGrant;
    readonly now: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
  readonly removeGrant: (input: {
    readonly grantId: string;
    readonly now: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
  /** Atomic take-or-report: the unique index on `claim_key` is the arbiter. */
  readonly acquireClaim: (
    input: ClaimAcquireInput,
  ) => Effect.Effect<ClaimAcquireOutcome, ManagerRepositoryError>;
  /** Releases only if the caller is the holder; `force` skips that check. */
  readonly releaseClaim: (input: {
    readonly claimKey: string;
    readonly holderEnvironmentId: string | null;
    readonly now: string;
  }) => Effect.Effect<boolean, ManagerRepositoryError>;
  readonly createRequest: (input: {
    readonly request: WorkspaceRequest;
  }) => Effect.Effect<void, ManagerRepositoryError>;
  readonly decideRequest: (input: {
    readonly requestId: string;
    readonly status: WorkspaceRequestStatus;
    readonly decidedAt: string;
  }) => Effect.Effect<Option.Option<WorkspaceRequest>, ManagerRepositoryError>;
  readonly getRequest: (input: {
    readonly requestId: string;
  }) => Effect.Effect<Option.Option<WorkspaceRequest>, ManagerRepositoryError>;
  readonly expireRequests: (input: {
    readonly now: string;
  }) => Effect.Effect<number, ManagerRepositoryError>;
  readonly recordActivity: (input: {
    readonly occurredAt: string;
    readonly fromEnvironmentId: string;
    readonly kind: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
  readonly countActivitySince: (input: {
    readonly since: string;
  }) => Effect.Effect<number, ManagerRepositoryError>;
  /** `environmentId` of `*` is the workspace-wide instruction layer. */
  readonly getInstructionText: (input: {
    readonly environmentId: string;
  }) => Effect.Effect<string, ManagerRepositoryError>;
  readonly setInstructionText: (input: {
    readonly environmentId: string;
    readonly text: string;
    readonly now: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
}

export class WorkspaceRegistryRepository extends Context.Service<
  WorkspaceRegistryRepository,
  WorkspaceRegistryRepositoryShape
>()("t3/persistence/Services/WorkspaceRegistry/WorkspaceRegistryRepository") {}
