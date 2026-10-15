/**
 * Files (pdf, docx, zip…) attached on Home's composer ride along to the new
 * chat's composer. Pictures travel through the draft store (they persist as
 * data URLs); plain files are in-memory `File`s, so they are handed over here
 * and the chat's composer takes them as soon as it is showing that draft —
 * before the pending send fires (see `pendingSendStore`).
 */
import { create } from "zustand";

import type { ComposerFileAttachment, DraftId } from "../../composerDraftStore";

interface ComposerFileHandoffState {
  readonly pending: Readonly<Record<string, ReadonlyArray<ComposerFileAttachment>>>;
  readonly handOff: (draftId: DraftId, files: ReadonlyArray<ComposerFileAttachment>) => void;
  /** The files waiting for `draftId` (removed from the store). */
  readonly take: (draftId: DraftId) => ReadonlyArray<ComposerFileAttachment>;
}

export const useComposerFileHandoffStore = create<ComposerFileHandoffState>((set, get) => ({
  pending: {},
  handOff: (draftId, files) => {
    if (files.length === 0) return;
    set((state) => ({
      pending: { ...state.pending, [draftId]: [...(state.pending[draftId] ?? []), ...files] },
    }));
  },
  take: (draftId) => {
    const files = get().pending[draftId] ?? [];
    if (files.length > 0) {
      set((state) => {
        const { [draftId]: _taken, ...rest } = state.pending;
        return { pending: rest };
      });
    }
    return files;
  },
}));
