/**
 * "Waiting for you · 3" (T52, Misha 20.11): what in this one chat still waits
 * for the person — a card nobody answered, a site or report link not opened,
 * a plain question the agent ended its answer to them with. In a coordinator
 * chat other agents keep writing, so these scroll away under later messages;
 * the strip above the composer keeps them in one place.
 *
 * Read from the feed alone (no new daemon state):
 * - a card (`show_card`, a page with `source: "card"`) is answered when a
 *   later message of the person starts with that card's marker line
 *   (`[from the card «…»]`, htmlRender.ts) or the page store says it sent;
 *   a later card with the same title replaces it ("Replaced by a newer card");
 * - links to the person's own sites/reports (`chatLinkTarget` "own") in the
 *   agent's message wait until each is opened (from the feed or the strip);
 * - a question: the agent's last message before the person spoke again, in a
 *   turn the person's own message started, ending with "?" — any later
 *   message of the person answers it. Narrow on purpose: agents talking to
 *   each other ask lots of questions that are not for the person.
 * The person can hide any item ("Not needed"); it stays hidden on this device.
 */
import { htmlRenderMessageMarker } from "@t3tools/shared/htmlRender";
import type { ThreadId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";

export type PendingForYouKind = "card" | "links" | "question";

export interface PendingForYouLink {
  readonly href: string;
  readonly label: string;
  readonly opened: boolean;
}

export interface PendingForYouItem {
  /** Stable across renders: the timeline entry's id. */
  readonly id: string;
  readonly kind: PendingForYouKind;
  readonly title: string;
  /** The feed entry the strip jumps to. */
  readonly entryId: string;
  readonly createdAt: string;
  /** Posted in a turn the person's own message started: it answers them. */
  readonly answersYou: boolean;
  /** The chat whose agent's message started that turn; null when the person's. */
  readonly broughtByThreadId: ThreadId | null;
  /** kind "links": every link, opened or not. */
  readonly links: ReadonlyArray<PendingForYouLink>;
  /** kind "card": the page, for "answered" from the page store. */
  readonly attachmentId: string | null;
}

export interface PendingForYou {
  /** What still waits, answers to the person first, then the oldest first. */
  readonly items: ReadonlyArray<PendingForYouItem>;
  /** Waiting items the person hid ("Not needed"). */
  readonly hidden: ReadonlyArray<PendingForYouItem>;
  /** Feed entries to mark: still waiting, or replaced by a newer card. */
  readonly marks: ReadonlyMap<string, "waiting" | "replaced">;
}

export interface DerivePendingForYouInput {
  readonly entries: ReadonlyArray<TimelineEntry>;
  /** Links the person opened in this chat (normalized hrefs). */
  readonly openedLinks: ReadonlySet<string>;
  /** Items the person hid. */
  readonly dismissedIds: ReadonlySet<string>;
  /** Pages that already sent the person's pick (htmlRenderPageMessages). */
  readonly answeredAttachmentIds?: ReadonlySet<string>;
  /** True for a link to the person's own site/app/report (`chatLinkTarget(href) === "own"`). */
  readonly isOwnLink: (href: string) => boolean;
}

/** A link's key for "opened": no trailing slash, no hash. */
export function normalizePendingLink(href: string): string {
  return href.trim().replace(/#.*$/, "").replace(/\/+$/, "");
}

const MARKDOWN_LINK = /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_LINK = /(?<![(\w])(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"])/g;

/** The links of an agent's message that point at the person's own things. */
export function ownLinksOf(
  text: string,
  isOwnLink: (href: string) => boolean,
): ReadonlyArray<{ href: string; label: string }> {
  const found = new Map<string, { href: string; label: string }>();
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const [, label = "", href = ""] = match;
    if (isOwnLink(href)) found.set(normalizePendingLink(href), { href, label: label.trim() });
  }
  const withoutMarkdown = text.replace(MARKDOWN_LINK, " ");
  for (const match of withoutMarkdown.matchAll(BARE_LINK)) {
    const href = match[1] ?? "";
    const key = normalizePendingLink(href);
    if (!isOwnLink(href) || found.has(key)) continue;
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
function plainLine(text: string, max = 72): string {
  const line = text
    .replace(MARKDOWN_LINK, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The message's first sentence (a links item's title). */
function firstSentence(text: string): string {
  const plain = plainLine(text, 400);
  const end = plain.search(/[.:!?](\s|$)/);
  return plainLine(end > 0 ? plain.slice(0, end) : plain);
}

/** The question the message ends with, or null. */
export function endingQuestion(text: string): string | null {
  const plain = plainLine(text, 2000);
  if (!plain.endsWith("?")) return null;
  const start = Math.max(
    plain.lastIndexOf(". ", plain.length - 2),
    plain.lastIndexOf("! ", plain.length - 2),
    plain.lastIndexOf("\n", plain.length - 2),
  );
  return plainLine(start >= 0 ? plain.slice(start + 2) : plain);
}

function titleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

const isPersonMessage = (entry: TimelineEntry) =>
  entry.kind === "message" && entry.message.role === "user" && entry.message.sentByThreadId == null;

export function derivePendingForYou(input: DerivePendingForYouInput): PendingForYou {
  const { entries, openedLinks, dismissedIds, isOwnLink } = input;
  const answeredPages = input.answeredAttachmentIds ?? new Set<string>();
  const marks = new Map<string, "waiting" | "replaced">();
  // Open items, in feed order; removed when answered or replaced.
  const open = new Map<string, PendingForYouItem>();
  const cardByTitle = new Map<string, string>();
  // Who started the turn we are in: the person, or the chat of an agent.
  let trigger: { answersYou: boolean; byThreadId: ThreadId | null } = {
    answersYou: false,
    byThreadId: null,
  };
  // The agent's last message since the person last spoke (a question candidate).
  let lastAgentAnswer: { entry: TimelineEntry & { kind: "message" }; answersYou: boolean } | null =
    null;

  const closeQuestion = () => {
    if (lastAgentAnswer === null || !lastAgentAnswer.answersYou) return;
    const question = endingQuestion(lastAgentAnswer.entry.message.text);
    if (question === null) return;
    const { entry } = lastAgentAnswer;
    open.set(`question:${entry.id}`, {
      id: `question:${entry.id}`,
      kind: "question",
      title: question,
      entryId: entry.id,
      createdAt: entry.createdAt,
      answersYou: true,
      broughtByThreadId: null,
      links: [],
      attachmentId: null,
    });
  };

  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      if (isPersonMessage(entry)) {
        // The person spoke: plain questions before are answered, and a card
        // whose marker opens this message is answered.
        for (const [id, item] of open) {
          if (item.kind === "question") open.delete(id);
          if (
            item.kind === "card" &&
            entry.message.text.startsWith(
              htmlRenderMessageMarker({ source: "card", title: item.title }),
            )
          ) {
            open.delete(id);
          }
        }
        lastAgentAnswer = null;
        trigger = { answersYou: true, byThreadId: null };
      } else {
        // An agent wrote: the person's turn (if any) is over; a question to
        // them stays only if it was their turn's last word.
        closeQuestion();
        lastAgentAnswer = null;
        trigger = { answersYou: false, byThreadId: entry.message.sentByThreadId ?? null };
      }
      continue;
    }

    if (entry.kind === "html-render" && entry.htmlRender.source === "card") {
      const key = titleKey(entry.htmlRender.title);
      const previous = cardByTitle.get(key);
      if (previous !== undefined && open.has(previous)) {
        // The card's id is its entry's: the old one in the feed reads "Replaced".
        open.delete(previous);
        marks.set(previous, "replaced");
      }
      cardByTitle.set(key, entry.id);
      if (answeredPages.has(entry.htmlRender.attachmentId)) continue;
      open.set(entry.id, {
        id: entry.id,
        kind: "card",
        title: entry.htmlRender.title,
        entryId: entry.id,
        createdAt: entry.createdAt,
        answersYou: trigger.answersYou,
        broughtByThreadId: trigger.byThreadId,
        links: [],
        attachmentId: entry.htmlRender.attachmentId,
      });
      continue;
    }

    if (entry.kind === "message" && entry.message.role === "assistant") {
      const links = ownLinksOf(entry.message.text, isOwnLink).map((link) => ({
        ...link,
        opened: openedLinks.has(normalizePendingLink(link.href)),
      }));
      if (links.some((link) => !link.opened)) {
        open.set(entry.id, {
          id: entry.id,
          kind: "links",
          title: firstSentence(entry.message.text),
          entryId: entry.id,
          createdAt: entry.createdAt,
          answersYou: trigger.answersYou,
          broughtByThreadId: trigger.byThreadId,
          links,
          attachmentId: null,
        });
      }
      lastAgentAnswer = { entry, answersYou: trigger.answersYou };
    }
  }
  closeQuestion();

  const waiting = [...open.values()].toSorted(
    (a, b) =>
      Number(b.answersYou) - Number(a.answersYou) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const items = waiting.filter((item) => !dismissedIds.has(item.id));
  const hidden = waiting.filter((item) => dismissedIds.has(item.id));
  for (const item of items) marks.set(item.entryId, "waiting");
  return { items, hidden, marks };
}

/** "Pricing: where we stand · Ship on Thursday? · +1": the folded strip's line. */
export function pendingForYouSummary(items: ReadonlyArray<PendingForYouItem>, max = 2): string {
  const shown = items.slice(0, max).map((item) => item.title);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} · +${rest}` : shown.join(" · ");
}

export const PENDING_KIND_LABEL: Record<PendingForYouKind, string> = {
  card: "Card",
  links: "Link",
  question: "Question",
};
