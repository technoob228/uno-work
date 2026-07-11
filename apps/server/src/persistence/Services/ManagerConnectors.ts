/**
 * ManagerConnectorRepository - Persistence for per-assistant connectors
 * (currently Telegram) and their chat→thread mappings. Every assistant
 * project owns its own connector rows — its own bot, its own allowlist.
 *
 * @module ManagerConnectorRepository
 */
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ManagerRepositoryError } from "../Errors.ts";

// Both connector tables carry this as a column, so a new kind slots into
// storage without a migration. Slack is wired at the contract/persistence
// layer; its live poller Layer lands separately.
export const ManagerConnectorKind = Schema.Literals(["telegram", "slack"]);
export type ManagerConnectorKind = typeof ManagerConnectorKind.Type;

export const ManagerConnectorRecord = Schema.Struct({
  projectId: ProjectId,
  kind: ManagerConnectorKind,
  config: Schema.Unknown,
  updatedAt: Schema.String,
});
export type ManagerConnectorRecord = typeof ManagerConnectorRecord.Type;

export interface ManagerConnectorRepositoryShape {
  readonly get: (input: {
    readonly projectId: ProjectId;
    readonly kind: ManagerConnectorKind;
  }) => Effect.Effect<Option.Option<ManagerConnectorRecord>, ManagerRepositoryError>;
  /** All connector rows of a kind across assistants (for the pollers). */
  readonly listByKind: (
    kind: ManagerConnectorKind,
  ) => Effect.Effect<ReadonlyArray<ManagerConnectorRecord>, ManagerRepositoryError>;
  readonly upsert: (input: {
    readonly projectId: ProjectId;
    readonly kind: ManagerConnectorKind;
    readonly config: unknown;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
  readonly getThreadForChat: (input: {
    readonly projectId: ProjectId;
    readonly kind: ManagerConnectorKind;
    readonly chatId: string;
  }) => Effect.Effect<Option.Option<ThreadId>, ManagerRepositoryError>;
  readonly setThreadForChat: (input: {
    readonly projectId: ProjectId;
    readonly kind: ManagerConnectorKind;
    readonly chatId: string;
    readonly threadId: ThreadId;
    readonly createdAt: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
}

export class ManagerConnectorRepository extends Context.Service<
  ManagerConnectorRepository,
  ManagerConnectorRepositoryShape
>()("t3/persistence/Services/ManagerConnectors/ManagerConnectorRepository") {}
