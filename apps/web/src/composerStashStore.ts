/**
 * ⌘S: set the typed message aside and bring it back in any chat, pictures and
 * files included (upstream `promptStashStore`, here on Lexical). Kept in this
 * browser or app, not on the computer.
 *
 * Videos and screen recordings stay in the chat they were made in: they are
 * tied to its processing job.
 */
import { create } from "zustand";

import type { ChatQuote } from "./lib/chatQuotes";
import { deleteStashEntry, readStash, writeStashEntry } from "./lib/stashDb";
import { randomUUID } from "./lib/utils";

export interface StashedMessage {
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
  /** Pictures and files, in the order they were attached. */
  readonly files: ReadonlyArray<File>;
  readonly quotes: ReadonlyArray<ChatQuote>;
}

interface ComposerStashState {
  /** Newest first. */
  readonly entries: ReadonlyArray<StashedMessage>;
  readonly loaded: boolean;
  /** Saved, or null when there is nothing to save. */
  readonly stash: (input: Omit<StashedMessage, "id" | "createdAt">) => StashedMessage | null;
  /** Removes it and returns it; null when it is already gone. */
  readonly take: (id: string) => StashedMessage | null;
  readonly remove: (id: string) => void;
}

const newestFirst = (entries: ReadonlyArray<StashedMessage>) =>
  entries.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

export const useComposerStashStore = create<ComposerStashState>()((set, get) => ({
  entries: [],
  loaded: false,
  stash: (input) => {
    if (input.text.trim().length === 0 && input.files.length === 0 && input.quotes.length === 0) {
      return null;
    }
    const entry: StashedMessage = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    set((state) => ({ entries: newestFirst([entry, ...state.entries]) }));
    void writeStashEntry(entry).catch(() => undefined);
    return entry;
  },
  take: (id) => {
    const entry = get().entries.find((candidate) => candidate.id === id) ?? null;
    if (entry) get().remove(id);
    return entry;
  },
  remove: (id) => {
    set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) }));
    void deleteStashEntry(id).catch(() => undefined);
  },
}));

/** Loads what was set aside earlier; a message set aside meanwhile stays. */
export function loadComposerStash(): void {
  if (useComposerStashStore.getState().loaded) return;
  useComposerStashStore.setState({ loaded: true });
  void readStash<StashedMessage>()
    .then((saved) => {
      useComposerStashStore.setState((state) => {
        const known = new Set(state.entries.map((entry) => entry.id));
        return {
          entries: newestFirst([
            ...state.entries,
            ...saved.filter((entry) => !known.has(entry.id)),
          ]),
        };
      });
    })
    .catch(() => undefined);
}

export type SetAsideResult =
  /** The box held something: it's aside now. */
  | { readonly kind: "aside"; readonly entry: StashedMessage }
  /** An empty box and one message set aside: it comes back. */
  | { readonly kind: "back"; readonly entry: StashedMessage }
  /** An empty box and several: the person picks. */
  | { readonly kind: "pick" }
  | { readonly kind: "nothing" };

/** ⌘S on a box, whichever box it is. */
export function setAsideOrBringBack(
  input: Omit<StashedMessage, "id" | "createdAt">,
): SetAsideResult {
  const store = useComposerStashStore.getState();
  const entry = store.stash(input);
  if (entry) return { kind: "aside", entry };
  const { entries } = useComposerStashStore.getState();
  const only = entries.length === 1 ? entries[0] : undefined;
  const taken = only ? store.take(only.id) : null;
  if (taken) return { kind: "back", entry: taken };
  return entries.length > 1 ? { kind: "pick" } : { kind: "nothing" };
}

type StashTarget = (entry: StashedMessage) => void;
let stashTarget: StashTarget | null = null;

/** The composer on screen takes what the sidebar's Drafts list brings back. */
export function registerStashTarget(target: StashTarget): () => void {
  stashTarget = target;
  return () => {
    if (stashTarget === target) stashTarget = null;
  };
}

/** Into the chat on screen; false when no chat is open (it stays set aside). */
export function restoreStashedMessage(id: string): boolean {
  const target = stashTarget;
  if (!target) return false;
  const entry = useComposerStashStore.getState().take(id);
  if (entry) target(entry);
  return entry !== null;
}

/** "Fix the header · 2 attachments": one line for lists. */
export function stashedMessagePreview(entry: {
  readonly text: string;
  readonly files: ReadonlyArray<unknown>;
  readonly quotes: ReadonlyArray<unknown>;
}): string {
  const line = entry.text.trim().split("\n", 1)[0] ?? "";
  const extras = entry.files.length + entry.quotes.length;
  const extrasLabel = extras === 0 ? "" : `${extras} attachment${extras === 1 ? "" : "s"}`;
  return [line, extrasLabel].filter(Boolean).join(" · ");
}
