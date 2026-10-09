/**
 * ManagerConnectorPendingReplyRepository - replies a Telegram/Slack chat is
 * still owed (`manager_connector_pending_replies`, migration 050).
 *
 * One row per chat message that a connector turned into a turn. The row is
 * written BEFORE the turn is dispatched and outlives the daemon: on start the
 * connector resumes every open row, so an answer that lands hours later (or
 * after an update) still goes to the message it answers. Rows go
 * `queued` (waiting for the thread to be free) → `waiting` (dispatched) →
 * `delivered` | `failed`.
 *
 * @module ManagerConnectorPendingReplyRepository
 */
import { MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { ManagerRepositoryError } from "../Errors.ts";
import { ManagerConnectorKind } from "./ManagerConnectors.ts";

export const ConnectorPendingReplyStatus = Schema.Literals([
  "queued",
  "waiting",
  "delivered",
  "failed",
]);
export type ConnectorPendingReplyStatus = typeof ConnectorPendingReplyStatus.Type;

export const ConnectorReplyLanguage = Schema.Literals(["ru", "en"]);

export const ConnectorPendingReply = Schema.Struct({
  kind: ManagerConnectorKind,
  /** The connector whose bot/app received the message and sends the answer. */
  connectorProjectId: ProjectId,
  /** Provider id of the chat message (Telegram `chat:message_id`, Slack `channel:ts`). */
  replyKey: Schema.String,
  /** Telegram chat id / Slack channel. */
  chatId: Schema.String,
  /** The message the answer replies to (Telegram message_id); null: none. */
  replyTo: Schema.NullOr(Schema.String),
  /** Slack thread to post into; null for a flat DM / Telegram. */
  replyThread: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  /** The user message the connector dispatched; the turn is found through it. */
  userMessageId: MessageId,
  /** The turn that answers it, once seen. */
  turnId: Schema.NullOr(TurnId),
  /** When `userMessageId` was dispatched (a resume moves it). */
  requestedAt: Schema.String,
  language: ConnectorReplyLanguage,
  /** Connector-specific bits (the dispatch to (re)send, hot-window key, identity). */
  meta: Schema.Unknown,
  status: ConnectorPendingReplyStatus,
  progressNotes: Schema.Number,
  resumeAttempts: Schema.Number,
  /** Parts of the answer (text chunks, then files) already sent. */
  deliveredParts: Schema.Number,
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ConnectorPendingReply = typeof ConnectorPendingReply.Type;

export interface ConnectorPendingReplyKey {
  readonly kind: ManagerConnectorKind;
  readonly connectorProjectId: ProjectId;
  readonly replyKey: string;
}

export interface ManagerConnectorPendingReplyRepositoryShape {
  /** Insert unless a row with this key exists; true when inserted. */
  readonly insertIfAbsent: (
    row: ConnectorPendingReply,
  ) => Effect.Effect<boolean, ManagerRepositoryError>;
  /** Write the whole row (the watcher owns it once inserted). */
  readonly save: (row: ConnectorPendingReply) => Effect.Effect<void, ManagerRepositoryError>;
  readonly get: (
    key: ConnectorPendingReplyKey,
  ) => Effect.Effect<Option.Option<ConnectorPendingReply>, ManagerRepositoryError>;
  /** `queued` and `waiting` rows of a kind, oldest first. */
  readonly listOpen: (
    kind: ManagerConnectorKind,
  ) => Effect.Effect<ReadonlyArray<ConnectorPendingReply>, ManagerRepositoryError>;
  /** The latest rows of a thread, any kind and status, oldest first. */
  readonly listByThread: (input: {
    readonly threadId: ThreadId;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ConnectorPendingReply>, ManagerRepositoryError>;
  /** Drop settled rows last touched before `before`. */
  readonly prune: (input: {
    readonly before: string;
  }) => Effect.Effect<void, ManagerRepositoryError>;
}

export class ManagerConnectorPendingReplyRepository extends Context.Service<
  ManagerConnectorPendingReplyRepository,
  ManagerConnectorPendingReplyRepositoryShape
>()(
  "t3/persistence/Services/ManagerConnectorPendingReplies/ManagerConnectorPendingReplyRepository",
) {}
