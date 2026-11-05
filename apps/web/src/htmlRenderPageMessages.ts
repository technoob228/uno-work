/**
 * A page in the chat answers the agent (`uno.send`, `data-uno-send`): the
 * message goes the way the person's own Enter does, through "Up next" — at
 * once when the agent is free, after its turn when it works, visible and
 * editable while it waits. The page never reaches the agent another way.
 *
 * What each page sent is kept per page (localStorage): the pace and the cap
 * hold across a reload, and a card shows itself answered when it comes back
 * into view (the list unmounts rows out of view; a reload starts the page
 * over).
 */
import {
  HTML_RENDER_MESSAGE_LIMITS,
  htmlRenderMessageVerdict,
  type HtmlRenderMessageVerdict,
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
    if (valid.length > 0) pages[attachmentId] = valid.slice(-HTML_RENDER_MESSAGE_LIMITS.perPage);
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

/** What this page already sent, oldest first. */
export function pageMessagesSent(attachmentId: string): ReadonlyArray<string> {
  return (usePageMessagesStore.getState().sentByPage[attachmentId] ?? []).map(
    (entry) => entry.text,
  );
}

/**
 * The app's decision on one message from a page, and the send when it's yes.
 * `gesture` is what the app saw itself (see `HtmlRenderDocument`).
 */
export function sendPageMessage(input: {
  readonly threadKey: string;
  readonly attachmentId: string;
  readonly text: string;
  readonly gesture: boolean;
  readonly now?: number;
}): HtmlRenderMessageVerdict {
  const now = input.now ?? Date.now();
  const sent = usePageMessagesStore.getState().sentByPage[input.attachmentId] ?? [];
  const verdict = htmlRenderMessageVerdict({
    text: input.text,
    gesture: input.gesture,
    now,
    sentAt: sent.map((entry) => entry.at),
  });
  if (!verdict.ok) return verdict;
  usePageMessagesStore.getState().record(input.attachmentId, { at: now, text: verdict.text });
  useQueuedMessageStore.getState().enqueue(input.threadKey, verdict.text);
  return verdict;
}
