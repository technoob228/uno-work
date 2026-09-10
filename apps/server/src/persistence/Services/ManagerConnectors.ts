/**
 * ManagerConnectorRepository - Persistence for per-assistant connectors
 * (Telegram, Slack), their chat→thread mappings, and the durable inbox
 * that makes inbound delivery survive restarts:
 *
 * - `manager_connector_state`: persisted poll offset + last observed health
 *   per (assistant, kind).
 * - `manager_connector_inbox`: one row per provider event, idempotent on
 *   (assistant, kind, provider event id). Events go `received` → `handled`
 *   (or `failed`); a row still `received` after a restart is replayed from
 *   its stored payload.
 *
 * Every assistant project owns its own connector rows — its own bot, its own
 * allowlist, its own offset.
 *
 * @module ManagerConnectorRepository
 */
import { ManagerConnectorHealthStatus, ProjectId, ThreadId } from "@t3tools/contracts";
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

export const ManagerConnectorState = Schema.Struct({
  projectId: ProjectId,
  kind: ManagerConnectorKind,
  /** Provider-specific resume cursor (Telegram: next `getUpdates` offset). */
  offset: Schema.Number,
  /** Opaque hash of the credential the offset belongs to (see `resetState`). */
  credentialFingerprint: Schema.NullOr(Schema.String),
  /** Null until the poller has observed the connector at least once. */
  status: Schema.NullOr(ManagerConnectorHealthStatus),
  lastOkAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  lastErrorAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type ManagerConnectorState = typeof ManagerConnectorState.Type;

/** `received` = not yet handled (replayed after a restart); the rest are terminal. */
export const ManagerConnectorInboxStatus = Schema.Literals(["received", "handled", "failed"]);
export type ManagerConnectorInboxStatus = typeof ManagerConnectorInboxStatus.Type;

export const ManagerConnectorInboxRow = Schema.Struct({
  projectId: ProjectId,
  kind: ManagerConnectorKind,
  providerEventId: Schema.String,
  payload: Schema.Unknown,
  receivedAt: Schema.String,
  handledAt: Schema.NullOr(Schema.String),
  status: ManagerConnectorInboxStatus,
  attempts: Schema.Number,
  error: Schema.NullOr(Schema.String),
});
export type ManagerConnectorInboxRow = typeof ManagerConnectorInboxRow.Type;

export interface ManagerConnectorKey {
  readonly projectId: ProjectId;
  readonly kind: ManagerConnectorKind;
}

/** Outcome of an idempotent inbox insert: `inserted`, or the existing row's status. */
export type ManagerConnectorInboxInsertOutcome = "inserted" | ManagerConnectorInboxStatus;

export interface ManagerConnectorRepositoryShape {
  readonly get: (
    input: ManagerConnectorKey,
  ) => Effect.Effect<Option.Option<ManagerConnectorRecord>, ManagerRepositoryError>;
  /** All connector rows of a kind across assistants (for the pollers). */
  readonly listByKind: (
    kind: ManagerConnectorKind,
  ) => Effect.Effect<ReadonlyArray<ManagerConnectorRecord>, ManagerRepositoryError>;
  readonly upsert: (
    input: ManagerConnectorKey & {
      readonly config: unknown;
      readonly updatedAt: string;
    },
  ) => Effect.Effect<void, ManagerRepositoryError>;
  readonly getThreadForChat: (
    input: ManagerConnectorKey & { readonly chatId: string },
  ) => Effect.Effect<Option.Option<ThreadId>, ManagerRepositoryError>;
  readonly setThreadForChat: (
    input: ManagerConnectorKey & {
      readonly chatId: string;
      readonly threadId: ThreadId;
      readonly createdAt: string;
    },
  ) => Effect.Effect<void, ManagerRepositoryError>;

  // --- Durable inbox & health state --------------------------------------

  readonly getState: (
    input: ManagerConnectorKey,
  ) => Effect.Effect<Option.Option<ManagerConnectorState>, ManagerRepositoryError>;
  /**
   * Bind the state row to a credential: creates the row, or — when the
   * fingerprint differs — restarts the offset from zero and clears the inbox
   * (the events of the previous bot are unrelated to the new one).
   */
  readonly resetState: (
    input: ManagerConnectorKey & {
      readonly credentialFingerprint: string;
      readonly updatedAt: string;
    },
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /**
   * Move the resume cursor forward. Never moves it backwards: a late writer
   * (recovery finishing after a fresh poll) must not re-open handled ground.
   */
  readonly advanceOffset: (
    input: ManagerConnectorKey & { readonly offset: number; readonly updatedAt: string },
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /**
   * Record an observed health transition. `connected` stamps `last_ok_at`;
   * any other status stamps `last_error`/`last_error_at` with `error`.
   */
  readonly recordHealth: (
    input: ManagerConnectorKey & {
      readonly status: ManagerConnectorHealthStatus;
      readonly error: string | null;
      readonly at: string;
    },
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /** Idempotent: an event already in the inbox is left untouched and its status returned. */
  readonly insertInboxEvent: (
    input: ManagerConnectorKey & {
      readonly providerEventId: string;
      readonly payload: unknown;
      readonly receivedAt: string;
    },
  ) => Effect.Effect<ManagerConnectorInboxInsertOutcome, ManagerRepositoryError>;
  /** Bump `attempts` before handling, so a crash mid-handling still counts. Returns the new count. */
  readonly beginInboxAttempt: (
    input: ManagerConnectorKey & { readonly providerEventId: string },
  ) => Effect.Effect<number, ManagerRepositoryError>;
  readonly markInboxHandled: (
    input: ManagerConnectorKey & { readonly providerEventId: string; readonly handledAt: string },
  ) => Effect.Effect<void, ManagerRepositoryError>;
  readonly markInboxFailed: (
    input: ManagerConnectorKey & {
      readonly providerEventId: string;
      readonly error: string;
      readonly failedAt: string;
    },
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /** Unhandled rows, oldest first, capped — restart recovery input. */
  readonly listPendingInbox: (
    input: ManagerConnectorKey & { readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<ManagerConnectorInboxRow>, ManagerRepositoryError>;
  readonly getInboxEvent: (
    input: ManagerConnectorKey & { readonly providerEventId: string },
  ) => Effect.Effect<Option.Option<ManagerConnectorInboxRow>, ManagerRepositoryError>;
  /** Drop terminal rows received before `before` (ISO) so the dedupe table stays small. */
  readonly pruneInbox: (input: {
    readonly before: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
}

export class ManagerConnectorRepository extends Context.Service<
  ManagerConnectorRepository,
  ManagerConnectorRepositoryShape
>()("t3/persistence/Services/ManagerConnectors/ManagerConnectorRepository") {}
