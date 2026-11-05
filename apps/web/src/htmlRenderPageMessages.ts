/**
 * A page in the chat answers the agent (`uno.send`, `data-uno-send`). Where it
 * goes depends on who drew the page, as the daemon recorded it at publish
 * (`HtmlRenderReference.source`), never on what the page says (Misha, 05.11):
 * - a `show_card` card ("card": Uno's own renderer) goes the way the person's
 *   own Enter does, through "Up next": at once when the agent is free, after
 *   its turn when it works, visible and editable while it waits;
 * - any other page (the agent's own HTML could hide a script that "presses"
 *   on the person's next click) only puts the text into this chat's message
 *   box, focused; it goes when the person presses Enter. Text already in the
 *   box stays: the page's text is added below it (`attachFromPanel`).
 * Either way the text starts with a line saying which page it came from
 * (`withHtmlRenderMessageMarker`), so the agent knows.
 *
 * What each card sent is kept per page (localStorage): the pace and the cap
 * hold across a reload, and a card shows itself answered when it comes back
 * into view (the list unmounts rows out of view; a reload starts the page
 * over). Text put into the box counts for the pace and the cap, but not as
 * sent: the person may still delete it.
 */
import {
  HTML_RENDER_MESSAGE_LIMITS,
  htmlRenderMessageVerdict,
  withHtmlRenderMessageMarker,
  type HtmlRenderMessageDelivery,
  type HtmlRenderSource,
} from "@t3tools/shared/htmlRender";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { useQueuedMessageStore } from "./queuedMessageStore";

export const HTML_RENDER_PAGE_MESSAGES_STORAGE_KEY = "uno.html-render-sent.v1";

/** Pages remembered; the oldest go first. */
const MAX_PAGES = 300;

interface SentFromPage {
  readonly at: number;
  readonly text: string;
  /** Put into the message box, not sent: not in what the page is told it sent. */
  readonly draft?: true;
}

interface PageMessagesState {
  /** attachmentId → what that page sent, oldest first. Insertion order is age. */
  readonly sentByPage: Readonly<Record<string, ReadonlyArray<SentFromPage>>>;
  record: (attachmentId: string, entry: SentFromPage) => void;
}

const storage = resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);

function readSent(value: unknown): Record<string, ReadonlyArray<SentFromPage>> {
  const raw = (value as { sentByPage?: unknown } | null | undefined)?.sentByPage;
  if (typeof raw !== "object" || raw === null) return {};
  const pages: Record<string, ReadonlyArray<SentFromPage>> = {};
  for (const [attachmentId, entries] of Object.entries(raw)) {
    if (!Array.isArray(entries)) continue;
    const valid = entries.filter(
      (entry): entry is SentFromPage =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as SentFromPage).at === "number" &&
        typeof (entry as SentFromPage).text === "string",
    );
    if (valid.length > 0) {
      pages[attachmentId] = valid
        .slice(-HTML_RENDER_MESSAGE_LIMITS.perPage)
        .map(
          (entry): SentFromPage =>
            entry.draft === true
              ? { at: entry.at, text: entry.text, draft: true }
              : { at: entry.at, text: entry.text },
        );
    }
  }
  return pages;
}

export const usePageMessagesStore = create<PageMessagesState>()(
  persist(
    (set) => ({
      sentByPage: {},
      record: (attachmentId, entry) =>
        set((state) => {
          const { [attachmentId]: previous = [], ...others } = state.sentByPage;
          const ids = Object.keys(others);
          const kept =
            ids.length >= MAX_PAGES
              ? Object.fromEntries(
                  ids.slice(ids.length - MAX_PAGES + 1).map((id) => [id, others[id]!]),
                )
              : others;
          // Re-inserted last: the page that just spoke is the newest.
          return { sentByPage: { ...kept, [attachmentId]: [...previous, entry] } };
        }),
    }),
    {
      name: HTML_RENDER_PAGE_MESSAGES_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({ sentByPage: state.sentByPage }),
      merge: (persisted, current) => ({ ...current, sentByPage: readSent(persisted) }),
    },
  ),
);

/** What this page already sent, oldest first (not what only went into the message box). */
export function pageMessagesSent(attachmentId: string): ReadonlyArray<string> {
  return (usePageMessagesStore.getState().sentByPage[attachmentId] ?? []).flatMap((entry) =>
    entry.draft ? [] : [entry.text],
  );
}

/** The page in the chat a message comes from, as the app knows it (not as the page says). */
export interface PageMessageOrigin {
  readonly threadKey: string;
  readonly attachmentId: string;
  /** From the page's reference: "card" only for show_card's pages. */
  readonly source: HtmlRenderSource | undefined;
  readonly title: string;
}

/**
 * The app's decision on one message from a page, and where it goes when it's
 * yes. `gesture` is what the app saw itself (see `HtmlRenderDocument`).
 * `toComposer` puts text into this chat's message box and focuses it; false:
 * no message box on screen.
 */
export function deliverPageMessage(
  input: PageMessageOrigin & {
    readonly text: string;
    readonly gesture: boolean;
    readonly toComposer: (text: string) => boolean;
    readonly now?: number;
  },
): HtmlRenderMessageDelivery {
  const now = input.now ?? Date.now();
  const sent = usePageMessagesStore.getState().sentByPage[input.attachmentId] ?? [];
  const verdict = htmlRenderMessageVerdict({
    text: input.text,
    gesture: input.gesture,
    now,
    sentAt: sent.map((entry) => entry.at),
  });
  if (!verdict.ok) return verdict;
  const text = withHtmlRenderMessageMarker(verdict.text, input);
  if (input.source === "card") {
    usePageMessagesStore.getState().record(input.attachmentId, { at: now, text: verdict.text });
    useQueuedMessageStore.getState().enqueue(input.threadKey, text);
    return { ok: true };
  }
  if (!input.toComposer(text)) {
    return { ok: false, reason: "Open this chat to answer: the text goes into your message box." };
  }
  usePageMessagesStore
    .getState()
    .record(input.attachmentId, { at: now, text: verdict.text, draft: true });
  return { ok: true, queued: "composer" };
}
