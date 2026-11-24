/**
 * Whether the person folded "Waiting for you" (T52), per chat, on this
 * device: a matter of screen room. What waits, what they hid and what they
 * opened lives on the computer (`thread.pendingForYou`).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

interface PendingForYouStoreState {
  readonly foldedByChat: Readonly<Record<string, boolean>>;
  setFolded: (chatKey: string, folded: boolean) => void;
}

const storage = resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);

export const usePendingForYouStore = create<PendingForYouStoreState>()(
  persist(
    (set) => ({
      foldedByChat: {},
      setFolded: (chatKey, folded) =>
        set((state) => ({ foldedByChat: { ...state.foldedByChat, [chatKey]: folded } })),
    }),
    {
      name: "uno.pending-for-you.v2",
      version: 2,
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({ foldedByChat: state.foldedByChat }),
    },
  ),
);
