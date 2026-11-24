/**
 * "Waiting for you" (T52, Misha 20.11, accepted 23.11): what in one chat
 * still waits for the person. In a coordinator chat other agents keep
 * writing, so a card or a link the person hasn't dealt with scrolls away;
 * the daemon keeps the list, and the strip above the composer, the count on
 * the chat's sidebar row and the chat's Inbox item all read it.
 *
 * A fold over the chat's feed, one entry at a time (the projection steps it
 * on each event and stores the state; a revert rebuilds it from the feed):
 * - a card (`show_card` page with `waitsForAnswer`) waits until a later
 *   message of the person starts with its marker line (`[from the card «…»]`,
 *   htmlRender.ts); a later card with the same title, or one that names it
 *   in `replaces`, replaces it (the old one reads "Replaced" in the feed);
 * - links to the person's own sites and reports (uno4.me) in an agent's
 *   message wait until each is opened (from the feed or the strip);
 * - the person hides an item ("Not needed") or shows it again.
 * Plain-text questions are not caught (Misha 23.11): agents end many answers
 * with "Want me to…?", and a choice is a card anyway.
 * Only what came after `since` counts: a chat from before this feature
 * starts empty instead of lighting up with every old card.
 */
import type { ThreadPendingForYou, ThreadPendingItem, ThreadPendingLink } from "@t3tools/contracts";

import { htmlRenderMessageMarker, type HtmlRenderReference } from "./htmlRender.ts";

/** Open items kept at most (the oldest go first). */
export const PENDING_FOR_YOU_MAX_ITEMS = 60;
/** Hidden ids, opened links and replaced cards kept at most, each. */
export const PENDING_FOR_YOU_MAX_MARKS = 200;
const TITLE_MAX = 120;

interface PendingRecord {
  readonly id: string;
  readonly kind: "card" | "links";
  readonly title: string;
  readonly createdAt: string;
  readonly answersYou: boolean;
  readonly broughtByThreadId: string | null;
  readonly messageId: string | null;
  readonly activityId: string | null;
  readonly attachmentId: string | null;
  readonly links: ReadonlyArray<{ readonly href: string; readonly label: string }>;
}

/** What the daemon keeps per chat between events. */
export interface PendingForYouState {
  readonly version: 1;
  readonly since: string;
  /** Waiting items, feed order (hidden ones too). */
  readonly open: ReadonlyArray<PendingRecord>;
  /** Activity ids of cards a newer card replaced. */
  readonly replaced: ReadonlyArray<string>;
  /** Who started the turn the feed is in: the person, or another chat's agent. */
  readonly trigger: { readonly answersYou: boolean; readonly byThreadId: string | null };
  readonly dismissed: ReadonlyArray<string>;
  /** Normalized hrefs. */
  readonly opened: ReadonlyArray<string>;
}

export type PendingFeedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly role: "user" | "assistant" | "system";
      readonly text: string;
      /** Set on a user-role message another chat's agent sent. */
      readonly sentByThreadId: string | null;
      readonly createdAt: string;
    }
  | {
      readonly type: "page";
      readonly activityId: string;
      readonly page: HtmlRenderReference;
      readonly createdAt: string;
    };

export interface PendingPersonAction {
  readonly dismiss?: ReadonlyArray<string>;
  readonly restore?: ReadonlyArray<string>;
  readonly opened?: ReadonlyArray<string>;
}

export function initialPendingForYouState(since: string): PendingForYouState {
  return {
    version: 1,
    since,
    open: [],
    replaced: [],
    trigger: { answersYou: false, byThreadId: null },
    dismissed: [],
    opened: [],
  };
}

/** A link's key for "opened": no hash, no trailing slash. */
export function normalizePendingLink(href: string): string {
  return href.trim().replace(/#.*$/, "").replace(/\/+$/, "");
}

/** A published site or report of the person (Uno Sites): uno4.me, *.uno4.me, *.uno4.work. */
export function isOwnSiteLink(href: string): boolean {
  let host: string;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "uno4.me" || host.endsWith(".uno4.me") || host.endsWith(".uno4.work");
}

const MARKDOWN_LINK = /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_LINK = /(?<![(\w])(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"])/g;

/** The links of a message that point at the person's own sites, in order, once each. */
export function ownLinksOf(
  text: string,
): ReadonlyArray<{ readonly href: string; readonly label: string }> {
  // Cheap exit: most messages have no site link at all.
  if (!text.includes("uno4.")) return [];
  const found = new Map<string, { href: string; label: string }>();
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const [, label = "", href = ""] = match;
    const key = normalizePendingLink(href);
    if (isOwnSiteLink(href) && !found.has(key)) found.set(key, { href, label: label.trim() });
  }
  const withoutMarkdown = text.replace(MARKDOWN_LINK, " ");
  for (const match of withoutMarkdown.matchAll(BARE_LINK)) {
    const href = match[1] ?? "";
    const key = normalizePendingLink(href);
    if (!isOwnSiteLink(href) || found.has(key)) continue;
    let label = href;
    try {
      label = new URL(href).hostname;
    } catch {
      // keep the address
    }
    found.set(key, { href, label });
  }
  return [...found.values()];
}

/** Markdown out, one line, at most `max` characters. */
function plainLine(text: string, max = TITLE_MAX): string {
  const line = text
    .replace(MARKDOWN_LINK, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The message's first sentence: a links item's title. */
function firstSentence(text: string): string {
  const plain = plainLine(text, 400);
  const end = plain.search(/[.:!?](\s|$)/);
  return plainLine(end > 0 ? plain.slice(0, end) : plain);
}

const titleKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ");

const keepLast = <T>(list: ReadonlyArray<T>, max: number) =>
  list.length > max ? list.slice(list.length - max) : list;

const withAdded = (list: ReadonlyArray<string>, values: ReadonlyArray<string>) => {
  const fresh = values.filter((value, index) => value && values.indexOf(value) === index);
  const next = [...list.filter((value) => !fresh.includes(value)), ...fresh];
  return keepLast(next, PENDING_FOR_YOU_MAX_MARKS);
};

const allOpened = (record: PendingRecord, opened: ReadonlySet<string>) =>
  record.links.every((link) => opened.has(normalizePendingLink(link.href)));

/** One feed entry into the state. Entries from before `since` are skipped. */
export function stepPendingForYou(
  state: PendingForYouState,
  entry: PendingFeedEntry,
): PendingForYouState {
  if (entry.createdAt < state.since) return state;

  if (entry.type === "page") {
    const { page } = entry;
    if (page.source !== "card") return state;
    const id = `card:${page.attachmentId}`;
    if (state.open.some((record) => record.id === id)) return state;
    // A newer card with the same title, or one that says it replaces it.
    const key = titleKey(page.title);
    const replacedRecords = state.open.filter(
      (record) =>
        record.kind === "card" &&
        (titleKey(record.title) === key ||
          (page.replaces !== undefined && record.attachmentId === page.replaces)),
    );
    const open = state.open.filter((record) => !replacedRecords.includes(record));
    const replaced = withAdded(
      state.replaced,
      replacedRecords.flatMap((record) => (record.activityId ? [record.activityId] : [])),
    );
    // Only a card that waits for an answer (and is from 0.0.192 on) is listed.
    if (page.waitsForAnswer !== true) return { ...state, open, replaced };
    const record: PendingRecord = {
      id,
      kind: "card",
      // As the page has it: its answer's marker line is made from it.
      title: page.title,
      createdAt: entry.createdAt,
      answersYou: state.trigger.answersYou,
      broughtByThreadId: state.trigger.byThreadId,
      messageId: null,
      activityId: entry.activityId,
      attachmentId: page.attachmentId,
      links: [],
    };
    return {
      ...state,
      open: keepLast([...open, record], PENDING_FOR_YOU_MAX_ITEMS),
      replaced,
    };
  }

  if (entry.role === "user" && entry.sentByThreadId === null) {
    // The person spoke: a card whose marker opens this message is answered,
    // and what the chat does next answers them.
    const open = state.open.filter(
      (record) =>
        record.kind !== "card" ||
        !entry.text.startsWith(htmlRenderMessageMarker({ source: "card", title: record.title })),
    );
    return { ...state, open, trigger: { answersYou: true, byThreadId: null } };
  }

  const trigger =
    entry.role === "user" ? { answersYou: false, byThreadId: entry.sentByThreadId } : state.trigger;
  if (entry.role === "system") return state;

  // An agent's message (this chat's, or a note another chat's agent sent):
  // links to the person's sites wait until opened. A link another waiting
  // item already has is not listed twice.
  const id = `links:${entry.id}`;
  const others = state.open.filter((record) => record.id !== id);
  const known = new Set(
    others.flatMap((record) => record.links.map((link) => normalizePendingLink(link.href))),
  );
  const opened = new Set(state.opened);
  const links = ownLinksOf(entry.text).filter(
    (link) => !known.has(normalizePendingLink(link.href)),
  );
  const previous = state.open.find((record) => record.id === id);
  if (links.every((link) => opened.has(normalizePendingLink(link.href)))) {
    return previous ? { ...state, open: others, trigger } : { ...state, trigger };
  }
  const record: PendingRecord = {
    id,
    kind: "links",
    title: firstSentence(entry.text) || links[0]!.label,
    createdAt: previous?.createdAt ?? entry.createdAt,
    answersYou: previous?.answersYou ?? trigger.answersYou,
    broughtByThreadId: previous?.broughtByThreadId ?? trigger.byThreadId,
    messageId: entry.id,
    activityId: null,
    attachmentId: null,
    links,
  };
  const open = previous
    ? state.open.map((item) => (item.id === id ? record : item))
    : keepLast([...state.open, record], PENDING_FOR_YOU_MAX_ITEMS);
  return { ...state, open, trigger };
}

/** What the person did: hid, showed again, opened links. */
export function applyPendingPersonAction(
  state: PendingForYouState,
  action: PendingPersonAction,
): PendingForYouState {
  const restore = new Set(action.restore ?? []);
  const dismissed = withAdded(
    state.dismissed.filter((id) => !restore.has(id)),
    (action.dismiss ?? []).filter((id) => !restore.has(id)),
  );
  const opened = withAdded(state.opened, (action.opened ?? []).map(normalizePendingLink));
  const openedSet = new Set(opened);
  const open = state.open.filter(
    (record) => record.kind !== "links" || !allOpened(record, openedSet),
  );
  return { ...state, dismissed, opened, open };
}

/** The whole feed folded from scratch (a revert, or tests). */
export function derivePendingForYouState(
  since: string,
  entries: ReadonlyArray<PendingFeedEntry>,
  kept?: Pick<PendingForYouState, "dismissed" | "opened">,
): PendingForYouState {
  let state = initialPendingForYouState(since);
  if (kept) state = { ...state, dismissed: kept.dismissed, opened: kept.opened };
  for (const entry of entries) state = stepPendingForYou(state, entry);
  return state;
}

/** A chat's messages and pages as one feed, oldest first. */
export function pendingFeedOf(input: {
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly sentByThreadId?: string | null | undefined;
    readonly createdAt: string;
    readonly streaming?: boolean;
  }>;
  readonly pages: ReadonlyArray<{
    readonly activityId: string;
    readonly page: HtmlRenderReference;
    readonly createdAt: string;
  }>;
}): PendingFeedEntry[] {
  const entries: PendingFeedEntry[] = [
    ...input.messages
      .filter((message) => message.streaming !== true)
      .map(
        (message): PendingFeedEntry => ({
          type: "message",
          id: message.id,
          role: message.role,
          text: message.text,
          sentByThreadId: message.sentByThreadId ?? null,
          createdAt: message.createdAt,
        }),
      ),
    ...input.pages.map((page): PendingFeedEntry => ({ type: "page", ...page })),
  ];
  return entries.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** What a client shows: visible items (answers to the person first, then oldest first), hidden ids. */
export function pendingForYouView(state: PendingForYouState): ThreadPendingForYou {
  const dismissed = new Set(state.dismissed);
  const opened = new Set(state.opened);
  const toItem = (record: PendingRecord): ThreadPendingItem => ({
    id: record.id,
    kind: record.kind,
    title: record.title,
    createdAt: record.createdAt as ThreadPendingItem["createdAt"],
    answersYou: record.answersYou,
    broughtByThreadId: record.broughtByThreadId as ThreadPendingItem["broughtByThreadId"],
    messageId: record.messageId as ThreadPendingItem["messageId"],
    activityId: record.activityId,
    attachmentId: record.attachmentId,
    links: record.links.map(
      (link): ThreadPendingLink => ({
        href: link.href,
        label: link.label,
        opened: opened.has(normalizePendingLink(link.href)),
      }),
    ),
  });
  const visible = state.open
    .filter((record) => !dismissed.has(record.id))
    .toSorted(
      (a, b) =>
        Number(b.answersYou) - Number(a.answersYou) || a.createdAt.localeCompare(b.createdAt),
    );
  return {
    items: visible.map(toItem),
    hidden: state.open.filter((record) => dismissed.has(record.id)).map(toItem),
    replacedActivityIds: [...state.replaced],
  };
}

/** The stored state, or null when it is missing or broken (then the chat starts afresh). */
export function parsePendingForYouState(raw: unknown): PendingForYouState | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<PendingForYouState>;
  if (
    record.version !== 1 ||
    typeof record.since !== "string" ||
    !Array.isArray(record.open) ||
    !Array.isArray(record.replaced) ||
    !Array.isArray(record.dismissed) ||
    !Array.isArray(record.opened) ||
    typeof record.trigger !== "object" ||
    record.trigger === null
  ) {
    return null;
  }
  return record as PendingForYouState;
}

/** "Ship on Thursday? · Pricing: where we stand · +1": a one-line list. */
export function pendingForYouSummary(
  items: ReadonlyArray<{ readonly title: string }>,
  max = 2,
): string {
  const shown = items.slice(0, max).map((item) => item.title);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} · +${rest}` : shown.join(" · ");
}
