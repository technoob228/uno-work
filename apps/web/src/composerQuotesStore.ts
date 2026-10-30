/**
 * Quotes waiting for the next message, per chat (lib/chatQuotes.ts). Kept
 * apart from the composer's draft: they come from the feed and from the panel,
 * and go with whichever send happens next. They survive a reload like a draft.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { type ChatQuote } from "./lib/chatQuotes";
import { randomUUID } from "./lib/utils";

const EMPTY: ReadonlyArray<ChatQuote> = [];

interface ComposerQuotesState {
  readonly items: Readonly<Record<string, ReadonlyArray<ChatQuote>>>;
  add: (threadKey: string, quote: Omit<ChatQuote, "id">) => void;
  setComment: (threadKey: string, id: string, comment: string) => void;
  remove: (threadKey: string, id: string) => void;
  /** Takes the chat's quotes for a send. */
  take: (threadKey: string) => ReadonlyArray<ChatQuote>;
  /** The send failed, or the message came back to the composer. */
  restore: (threadKey: string, quotes: ReadonlyArray<ChatQuote>) => void;
}

const withQuotes = (
  items: ComposerQuotesState["items"],
  threadKey: string,
  quotes: ReadonlyArray<ChatQuote>,
) => {
  const next = { ...items };
  if (quotes.length === 0) delete next[threadKey];
  else next[threadKey] = quotes;
  return next;
};

export const useComposerQuotesStore = create<ComposerQuotesState>()(
  persist(
    (set, get) => ({
      items: {},
      add: (threadKey, quote) =>
        set(({ items }) => ({
          items: withQuotes(items, threadKey, [
            ...(items[threadKey] ?? EMPTY),
            { ...quote, id: randomUUID() },
          ]),
        })),
      setComment: (threadKey, id, comment) =>
        set(({ items }) => ({
          items: withQuotes(
            items,
            threadKey,
            (items[threadKey] ?? EMPTY).map((quote) =>
              quote.id === id ? { ...quote, comment } : quote,
            ),
          ),
        })),
      remove: (threadKey, id) =>
        set(({ items }) => ({
          items: withQuotes(
            items,
            threadKey,
            (items[threadKey] ?? EMPTY).filter((quote) => quote.id !== id),
          ),
        })),
      take: (threadKey) => {
        const quotes = get().items[threadKey] ?? EMPTY;
        if (quotes.length > 0) {
          set(({ items }) => ({ items: withQuotes(items, threadKey, EMPTY) }));
        }
        return quotes;
      },
      restore: (threadKey, quotes) =>
        set(({ items }) => ({
          items: withQuotes(items, threadKey, [...quotes, ...(items[threadKey] ?? EMPTY)]),
        })),
    }),
    { name: "uno-composer-quotes", storage: createJSONStorage(() => localStorage) },
  ),
);

export const useComposerQuotes = (threadKey: string | null | undefined) =>
  useComposerQuotesStore((state) => (threadKey ? (state.items[threadKey] ?? EMPTY) : EMPTY));
