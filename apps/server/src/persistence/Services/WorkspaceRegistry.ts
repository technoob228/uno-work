/**
 * WorkspaceRegistryRepository — durable state for the workspace a daemon
 * belongs to: its machines and the instruction layers agents read.
 *
 * The grant / claim / request half of migration 038 is gone: nothing checked
 * those rows, and the RPCs that wrote them were open to any connected client.
 *
 * Every mutation bumps `epoch`. Readers compare epochs to tell "my view is
 * stale" from "nothing has changed" — the panel says that out loud, because a
 * silently stale registry looks exactly like a healthy one.
 *
 * @module WorkspaceRegistryRepository
 */
import type { WorkspaceIdentity, WorkspaceMachine, WorkspaceState } from "@t3tools/contracts";
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
  /** Full snapshot: identity and machines. */
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
