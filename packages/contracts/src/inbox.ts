/**
 * Inbox — one place for everything on this computer that wants the person:
 * an agent finished, an agent waits for an approval or an answer, a chat
 * failed, and events of apps ("Boris commented on report.docx").
 *
 * The daemon keeps the items (they survive restarts) and pushes the whole
 * list to every window; windows only ask it to mark items read, snooze or
 * dismiss them. Apps post through the App API (`POST /v1/notify`,
 * docs/app-sdk.md), built-in parts of Uno (Office) post directly.
 */
import { Schema } from "effect";

/**
 * - `agent.done`     — an agent finished its turn;
 * - `agent.approval` — an agent waits for an approval (edit a file, run a command);
 * - `agent.input`    — an agent asked the person a question;
 * - `agent.error`    — a chat stopped with an error;
 * - `app`            — an app (or a built-in part of Uno) told the person something.
 */
export const InboxItemKind = Schema.Literals([
  "agent.done",
  "agent.approval",
  "agent.input",
  "agent.error",
  "app",
]);
export type InboxItemKind = typeof InboxItemKind.Type;

/** Kinds that wait for the person — shown as "Needs you". */
export const INBOX_NEEDS_YOU_KINDS: ReadonlySet<InboxItemKind> = new Set([
  "agent.approval",
  "agent.input",
]);

/**
 * What "Open" does:
 * - `thread` — the chat;
 * - `file`   — a file on the computer (documents open in Office, the rest in Files);
 * - `app`    — an app of the computer inside Uno, optionally at a path of it;
 * - `url`    — an http(s) address, opened inside Uno.
 */
export const InboxOpenTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("file"), path: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("app"),
    appId: Schema.String,
    path: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
]);
export type InboxOpenTarget = typeof InboxOpenTarget.Type;

/** Who the item is from: a chat's agent, an app (by manifest id) or Uno itself. */
export const InboxSource = Schema.Struct({
  kind: Schema.Literals(["agent", "app", "system"]),
  /** Thread id for agents, app id for apps (`office` for Office), `uno` for Uno. */
  id: Schema.String,
  name: Schema.String,
  /** Emoji or a couple of letters; null = the kind's own icon. */
  icon: Schema.NullOr(Schema.String),
});
export type InboxSource = typeof InboxSource.Type;

export const InboxItem = Schema.Struct({
  id: Schema.String,
  kind: InboxItemKind,
  source: InboxSource,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  open: Schema.NullOr(InboxOpenTarget),
  createdAt: Schema.String,
  /** Last time the item changed (a repeat of the same event bumps it). */
  updatedAt: Schema.String,
  /** How many times the same event came while the item was unread. */
  count: Schema.Number,
  readAt: Schema.NullOr(Schema.String),
  /** Hidden until then; comes back unread. */
  snoozedUntil: Schema.NullOr(Schema.String),
});
export type InboxItem = typeof InboxItem.Type;

export const InboxSnapshot = Schema.Struct({
  /** Newest first; dismissed items are gone. */
  items: Schema.Array(InboxItem),
  /** Unread items that are not snoozed. */
  unread: Schema.Number,
});
export type InboxSnapshot = typeof InboxSnapshot.Type;

/**
 * - `read` / `unread` — the listed `ids`, or every item of `threadId`;
 * - `readAll`         — every item;
 * - `snooze`          — hide `ids` until `until` (ISO time);
 * - `unsnooze`        — bring `ids` back now;
 * - `dismiss`         — delete `ids`;
 * - `clearRead`       — delete every read item.
 */
export const InboxUpdateAction = Schema.Literals([
  "read",
  "unread",
  "readAll",
  "snooze",
  "unsnooze",
  "dismiss",
  "clearRead",
]);
export type InboxUpdateAction = typeof InboxUpdateAction.Type;

export const InboxUpdateInput = Schema.Struct({
  action: InboxUpdateAction,
  ids: Schema.optional(Schema.Array(Schema.String)),
  threadId: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
});
export type InboxUpdateInput = typeof InboxUpdateInput.Type;

export class InboxError extends Schema.TaggedErrorClass<InboxError>()("InboxError", {
  message: Schema.String,
}) {}
