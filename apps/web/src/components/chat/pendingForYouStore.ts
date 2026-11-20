/**
 * What the person did with "Waiting for you" (T52), per chat: the items they
 * hid ("Not needed"), the links they opened, and whether they folded the
 * strip. On this device only (localStorage) in this cut; the full version
 * keeps it on the computer so the Inbox and other devices agree (DESIGN.md).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { normalizePendingLink } from "./pendingForYou.logic";

const MAX_PER_CHAT = 200;

interface PendingForYouStoreState {
  readonly dismissedByChat: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly openedByChat: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly foldedByChat: Readonly<Record<string, boolean>>;
  dismiss: (chatKey: string, itemId: string) => void;
  restore: (chatKey: string, itemIds: ReadonlyArray<string>) => void;
  markOpened: (chatKey: string, href: string) => void;
  setFolded: (chatKey: string, folded: boolean) => void;
}

const storage = resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);

const added = (list: ReadonlyArray<string> | undefined, value: string) =>
  list?.includes(value) ? list : [...(list ?? []), value].slice(-MAX_PER_CHAT);

export const usePendingForYouStore = create<PendingForYouStoreState>()(
  persist(
    (set) => ({
      dismissedByChat: {},
      openedByChat: {},
      foldedByChat: {},
      dismiss: (chatKey, itemId) =>
        set((state) => ({
          dismissedByChat: {
            ...state.dismissedByChat,
            [chatKey]: added(state.dismissedByChat[chatKey], itemId),
          },
        })),
      restore: (chatKey, itemIds) =>
        set((state) => ({
          dismissedByChat: {
            ...state.dismissedByChat,
            [chatKey]: (state.dismissedByChat[chatKey] ?? []).filter((id) => !itemIds.includes(id)),
          },
        })),
      markOpened: (chatKey, href) =>
        set((state) => ({
          openedByChat: {
            ...state.openedByChat,
            [chatKey]: added(state.openedByChat[chatKey], normalizePendingLink(href)),
          },
        })),
      setFolded: (chatKey, folded) =>
        set((state) => ({ foldedByChat: { ...state.foldedByChat, [chatKey]: folded } })),
    }),
    {
      name: "uno.pending-for-you.v1",
      version: 1,
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({
        dismissedByChat: state.dismissedByChat,
        openedByChat: state.openedByChat,
        foldedByChat: state.foldedByChat,
      }),
    },
  ),
);
