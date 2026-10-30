import type { MessageId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Find in a chat (⌘F). One bar at a time, for the chat in `threadKey`: moving
 * to another chat closes it. `jump` is a message to open at, from ⌘K: the bar
 * comes up with the query, on that message.
 */
interface ThreadFindStore {
  threadKey: string | null;
  query: string;
  /** Bumped by each ⌘F, so an open bar takes focus again. */
  focusRequestId: number;
  jump: { readonly messageId: MessageId; readonly requestId: number } | null;
  open: (threadKey: string) => void;
  close: () => void;
  setQuery: (query: string) => void;
  jumpTo: (input: {
    readonly threadKey: string;
    readonly query: string;
    readonly messageId: MessageId;
  }) => void;
  clearJump: () => void;
}

export const useThreadFindStore = create<ThreadFindStore>((set) => ({
  threadKey: null,
  query: "",
  focusRequestId: 0,
  jump: null,
  open: (threadKey) =>
    set((state) => ({
      threadKey,
      query: state.threadKey === threadKey ? state.query : "",
      focusRequestId: state.focusRequestId + 1,
      jump: null,
    })),
  close: () => set({ threadKey: null, query: "", jump: null }),
  setQuery: (query) => set({ query, jump: null }),
  jumpTo: ({ threadKey, query, messageId }) =>
    set((state) => ({
      threadKey,
      query,
      jump: { messageId, requestId: (state.jump?.requestId ?? 0) + 1 },
    })),
  clearJump: () => set({ jump: null }),
}));
