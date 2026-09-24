/**
 * Inbox — the pure half: what an item looks like on disk, how a new event
 * joins the list (a repeat of the same event bumps the unread item instead of
 * stacking), what the person's actions do, and what is dropped over time.
 *
 * No I/O here; `InboxService.ts` persists the list and pushes it to windows.
 */
import type {
  InboxItem,
  InboxItemKind,
  InboxOpenTarget,
  InboxSnapshot,
  InboxSource,
  InboxUpdateInput,
} from "@t3tools/contracts";
import { randomBytes } from "node:crypto";

/** Items kept at most; the oldest read ones go first, then the oldest at all. */
export const INBOX_MAX_ITEMS = 300;
/** Read items older than this are dropped. */
export const INBOX_READ_TTL_MS = 14 * 24 * 60 * 60_000;
/** Unread items older than this are dropped too (nobody is coming back for them). */
export const INBOX_UNREAD_TTL_MS = 60 * 24 * 60 * 60_000;
/** A snooze longer than this is cut to it. */
export const INBOX_MAX_SNOOZE_MS = 30 * 24 * 60 * 60_000;

export const INBOX_TITLE_MAX = 140;
export const INBOX_BODY_MAX = 500;

/** Stored item: the public shape plus the key repeats are folded by. */
export interface StoredInboxItem extends InboxItem {
  /**
   * Same key + still unread → the new event updates this item (text, time,
   * count) instead of adding one. Null = never folded.
   */
  readonly groupKey: string | null;
}

export interface InboxPost {
  readonly kind: InboxItemKind;
  readonly source: InboxSource;
  readonly title: string;
  readonly body?: string | null;
  readonly open?: InboxOpenTarget | null;
  readonly groupKey?: string | null;
}

// C0/C1 controls and bidi overrides: an app's text must not reorder the UI.
// (A string, so the escapes stay readable after formatting.)
const UNSAFE_TEXT_RE = new RegExp(
  // oxlint-disable-next-line no-control-regex
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]",
  "g",
);

export function cleanInboxText(value: string, max: number): string {
  const text = value
    .replace(UNSAFE_TEXT_RE, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function newInboxItemId(): string {
  return `inb_${randomBytes(9).toString("base64url")}`;
}

const isVisible = (item: InboxItem, nowMs: number) =>
  item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= nowMs;

export function toSnapshot(items: ReadonlyArray<StoredInboxItem>, nowMs: number): InboxSnapshot {
  const sorted = items.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    items: sorted.map(({ groupKey: _groupKey, ...item }) => item),
    unread: sorted.filter((item) => item.readAt === null && isVisible(item, nowMs)).length,
  };
}

/** Add an event, or fold it into the unread item with the same group key. */
export function addToInbox(
  items: ReadonlyArray<StoredInboxItem>,
  post: InboxPost,
  now: Date,
  id: string = newInboxItemId(),
): { readonly items: StoredInboxItem[]; readonly item: StoredInboxItem } {
  const at = now.toISOString();
  const title = cleanInboxText(post.title, INBOX_TITLE_MAX) || post.source.name;
  const body =
    post.body === undefined || post.body === null
      ? null
      : cleanInboxText(post.body, INBOX_BODY_MAX) || null;
  const groupKey = post.groupKey ?? null;
  const existing =
    groupKey === null
      ? undefined
      : items.find((item) => item.groupKey === groupKey && item.readAt === null);
  if (existing) {
    const item: StoredInboxItem = {
      ...existing,
      kind: post.kind,
      source: post.source,
      title,
      body,
      open: post.open ?? existing.open,
      updatedAt: at,
      count: existing.count + 1,
      // A repeat of something snoozed is news again.
      snoozedUntil: null,
    };
    return { items: items.map((entry) => (entry === existing ? item : entry)), item };
  }
  const item: StoredInboxItem = {
    id,
    kind: post.kind,
    source: post.source,
    title,
    body,
    open: post.open ?? null,
    createdAt: at,
    updatedAt: at,
    count: 1,
    readAt: null,
    snoozedUntil: null,
    groupKey,
  };
  return { items: prune([item, ...items], now.getTime()), item };
}

/** Drop what is old or too many. Keeps the newest; read items go before unread ones. */
export function prune(items: ReadonlyArray<StoredInboxItem>, nowMs: number): StoredInboxItem[] {
  const alive = items.filter((item) => {
    const age = nowMs - Date.parse(item.updatedAt);
    return item.readAt === null ? age < INBOX_UNREAD_TTL_MS : age < INBOX_READ_TTL_MS;
  });
  if (alive.length <= INBOX_MAX_ITEMS) return alive;
  const byAge = alive.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const unread = byAge.filter((item) => item.readAt === null);
  const read = byAge.filter((item) => item.readAt !== null);
  const keepRead = Math.max(0, INBOX_MAX_ITEMS - unread.length);
  const kept = new Set([...unread.slice(0, INBOX_MAX_ITEMS), ...read.slice(0, keepRead)]);
  return byAge.filter((item) => kept.has(item));
}

export class InboxInputError extends Error {}

/** What the person did to the list. Throws {@link InboxInputError} on bad input. */
export function applyInboxUpdate(
  items: ReadonlyArray<StoredInboxItem>,
  input: InboxUpdateInput,
  now: Date,
): StoredInboxItem[] {
  const at = now.toISOString();
  const ids = new Set(input.ids ?? []);
  const threadId = input.threadId;
  const targets = (item: StoredInboxItem) =>
    ids.has(item.id) ||
    (threadId !== undefined && item.open?.kind === "thread" && item.open.threadId === threadId);
  switch (input.action) {
    case "read":
      return items.map((item) =>
        targets(item) && item.readAt === null ? { ...item, readAt: at } : item,
      );
    case "unread":
      return items.map((item) => (targets(item) ? { ...item, readAt: null } : item));
    case "readAll":
      return items.map((item) =>
        item.readAt === null && isVisible(item, now.getTime()) ? { ...item, readAt: at } : item,
      );
    case "snooze": {
      const until = input.until === undefined ? Number.NaN : Date.parse(input.until);
      if (!Number.isFinite(until) || until <= now.getTime()) {
        throw new InboxInputError("Pick a time in the future.");
      }
      const capped = new Date(Math.min(until, now.getTime() + INBOX_MAX_SNOOZE_MS)).toISOString();
      return items.map((item) =>
        targets(item) ? { ...item, snoozedUntil: capped, readAt: null } : item,
      );
    }
    case "unsnooze":
      return items.map((item) => (targets(item) ? { ...item, snoozedUntil: null } : item));
    case "dismiss":
      return items.filter((item) => !targets(item));
    case "clearRead":
      return items.filter((item) => item.readAt === null);
  }
}

/** Snoozed items whose time has come: visible again, unread. */
export function wakeSnoozed(
  items: ReadonlyArray<StoredInboxItem>,
  nowMs: number,
): { readonly items: StoredInboxItem[]; readonly woke: StoredInboxItem[] } {
  const woke: StoredInboxItem[] = [];
  const next = items.map((item) => {
    if (item.snoozedUntil === null || Date.parse(item.snoozedUntil) > nowMs) return item;
    const awake = { ...item, snoozedUntil: null, readAt: null };
    woke.push(awake);
    return awake;
  });
  return { items: next, woke };
}

/** The earliest snooze still ahead, for the wake timer. */
export function nextWakeAt(items: ReadonlyArray<StoredInboxItem>, nowMs: number): number | null {
  let next: number | null = null;
  for (const item of items) {
    if (item.snoozedUntil === null) continue;
    const at = Date.parse(item.snoozedUntil);
    if (at > nowMs && (next === null || at < next)) next = at;
  }
  return next;
}

/** Old and broken entries of the file are skipped, never fatal. */
export function parseStoredItems(raw: unknown): StoredInboxItem[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { items?: unknown }).items;
  if (!Array.isArray(list)) return [];
  const out: StoredInboxItem[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Partial<StoredInboxItem>;
    if (
      typeof item.id !== "string" ||
      typeof item.kind !== "string" ||
      typeof item.title !== "string" ||
      typeof item.createdAt !== "string" ||
      typeof item.updatedAt !== "string" ||
      typeof item.source !== "object" ||
      item.source === null
    ) {
      continue;
    }
    out.push({
      id: item.id,
      kind: item.kind,
      source: item.source,
      title: item.title,
      body: typeof item.body === "string" ? item.body : null,
      open: item.open ?? null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      count: typeof item.count === "number" ? item.count : 1,
      readAt: typeof item.readAt === "string" ? item.readAt : null,
      snoozedUntil: typeof item.snoozedUntil === "string" ? item.snoozedUntil : null,
      groupKey: typeof item.groupKey === "string" ? item.groupKey : null,
    });
  }
  return out;
}
