/**
 * "Send this as soon as the chat is ready": Home's composer opens a new chat
 * with the task already typed and asks the chat to send it once it has
 * mounted — the same send the person's Enter would do (model, attachments,
 * worktree bootstrap and all live in ChatView, so the chat sends it itself).
 *
 * One request at a time, for one draft, and only for a short while: if the
 * chat can't send (no connection, no model yet), the text simply stays typed.
 */
import { create } from "zustand";

import type { DraftId } from "../../composerDraftStore";

/** After this the request is dropped; the prompt stays in the composer. */
export const PENDING_SEND_TTL_MS = 30_000;

export interface PendingSend {
  readonly draftId: DraftId;
  readonly prompt: string;
  readonly requestedAt: number;
}

interface PendingSendState {
  readonly pending: PendingSend | null;
  readonly request: (draftId: DraftId, prompt: string) => void;
  readonly clear: () => void;
}

export const usePendingSendStore = create<PendingSendState>((set) => ({
  pending: null,
  request: (draftId, prompt) => set({ pending: { draftId, prompt, requestedAt: Date.now() } }),
  clear: () => set({ pending: null }),
}));

/**
 * Should the chat send now? Only its own request, only while fresh, only when
 * the composer holds exactly the text Home put there (the person may have
 * edited it meanwhile — then it's theirs to send).
 */
export function pendingSendDecision(
  pending: PendingSend | null,
  input: { draftId: DraftId | null; composerPrompt: string; ready: boolean; now: number },
): "send" | "wait" | "drop" | "ignore" {
  if (pending === null || input.draftId === null || pending.draftId !== input.draftId) {
    return "ignore";
  }
  if (input.now - pending.requestedAt > PENDING_SEND_TTL_MS) return "drop";
  if (!input.ready) return "wait";
  if (input.composerPrompt.trim() !== pending.prompt.trim()) {
    // Not synced into the composer yet, or edited by the person.
    return input.composerPrompt.trim().length === 0 ? "wait" : "drop";
  }
  return "send";
}
