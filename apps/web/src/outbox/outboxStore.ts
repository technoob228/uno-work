/**
 * Outbox: chat messages written while the chat's computer is unreachable.
 *
 * A message sent with no live link (or whose send failed because the link
 * dropped) is kept here instead of bouncing back into the composer. It is
 * persisted in localStorage, so it survives a reload, shows in the chat right
 * away as "will send when back online", and the flusher (outboxFlusher.ts)
 * delivers it once the link is back. Delivery is idempotent: the stored
 * command keeps its commandId across reconnects, and the server deduplicates
 * by it, so a send that did reach the server before the link died is never
 * applied twice. Only an explicit Retry after a server rejection gets a new
 * commandId (the rejected one would be rejected again from its receipt).
 *
 * Only plain sends are queued: text (and terminal context, which is text) to
 * a chat that already exists on the server. Attachments need an upload and a
 * first message may need a new chat or worktree prepared - those still need a
 * live link and keep the old behaviour.
 */
import type { ClientOrchestrationCommand, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { newCommandId } from "../lib/utils";

export type OutboxTurnStartCommand = Extract<
  ClientOrchestrationCommand,
  { type: "thread.turn.start" }
>;

export type OutboxEntryStatus = "waiting" | "sending" | "failed";

export interface OutboxEntry {
  /** = command.message.messageId (stable; the commandId changes on Retry) */
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly queuedAt: string;
  readonly command: OutboxTurnStartCommand;
  readonly status: OutboxEntryStatus;
  readonly attempts: number;
  /** Server-side rejection (not a connection problem); shown with Retry/Discard. */
  readonly error: string | null;
}

interface OutboxState {
  readonly entries: ReadonlyArray<OutboxEntry>;
  readonly enqueue: (input: {
    readonly environmentId: EnvironmentId;
    readonly command: OutboxTurnStartCommand;
  }) => void;
  readonly markSending: (id: string) => void;
  /** Link dropped again mid-send: back in line, no error. */
  readonly markWaiting: (id: string) => void;
  readonly markFailed: (id: string, error: string) => void;
  readonly remove: (id: string) => void;
  readonly retry: (id: string) => void;
}

export const OUTBOX_STORAGE_KEY = "uno.outbox.v1";

function patchEntry(
  entries: ReadonlyArray<OutboxEntry>,
  id: string,
  patch: (entry: OutboxEntry) => OutboxEntry,
): ReadonlyArray<OutboxEntry> {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return patch(entry);
  });
  return changed ? next : entries;
}

function requeueInterruptedSend(entry: OutboxEntry): OutboxEntry {
  return entry.status === "sending" ? { ...entry, status: "waiting" } : entry;
}

export const useOutboxStore = create<OutboxState>()(
  persist(
    (set) => ({
      entries: [],
      enqueue: ({ environmentId, command }) =>
        set((state) =>
          state.entries.some((entry) => entry.id === command.message.messageId)
            ? state
            : {
                entries: [
                  ...state.entries,
                  {
                    id: command.message.messageId,
                    environmentId,
                    threadId: command.threadId,
                    queuedAt: new Date().toISOString(),
                    command,
                    status: "waiting",
                    attempts: 0,
                    error: null,
                  },
                ],
              },
        ),
      markSending: (id) =>
        set((state) => ({
          entries: patchEntry(state.entries, id, (entry) => ({
            ...entry,
            status: "sending",
            attempts: entry.attempts + 1,
          })),
        })),
      markWaiting: (id) =>
        set((state) => ({
          entries: patchEntry(state.entries, id, (entry) => ({ ...entry, status: "waiting" })),
        })),
      markFailed: (id, error) =>
        set((state) => ({
          entries: patchEntry(state.entries, id, (entry) => ({
            ...entry,
            status: "failed",
            error,
          })),
        })),
      remove: (id) =>
        set((state) => {
          const next = state.entries.filter((entry) => entry.id !== id);
          return next.length === state.entries.length ? state : { entries: next };
        }),
      retry: (id) =>
        set((state) => ({
          entries: patchEntry(state.entries, id, (entry) => ({
            ...entry,
            command: { ...entry.command, commandId: newCommandId() },
            status: "waiting",
            error: null,
          })),
        })),
    }),
    {
      name: OUTBOX_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ entries: state.entries }),
      // A reload interrupts any in-flight send: resend it (same commandId).
      merge: (persisted, current) => {
        const entries = (persisted as { entries?: ReadonlyArray<OutboxEntry> } | undefined)
          ?.entries;
        return {
          ...current,
          entries: Array.isArray(entries) ? entries.map(requeueInterruptedSend) : [],
        };
      },
    },
  ),
);

export function selectOutboxEntriesForThread(
  entries: ReadonlyArray<OutboxEntry>,
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): ReadonlyArray<OutboxEntry> {
  if (!environmentId || !threadId) return [];
  return entries.filter(
    (entry) => entry.environmentId === environmentId && entry.threadId === threadId,
  );
}

/**
 * What the flusher may send now: per chat, the oldest entry, only if nothing
 * of that chat is already in flight or failed (keeps messages in order).
 */
export function nextOutboxDeliveries(
  entries: ReadonlyArray<OutboxEntry>,
  isEnvironmentReady: (environmentId: EnvironmentId) => boolean,
): ReadonlyArray<OutboxEntry> {
  const blockedThreads = new Set<string>();
  const ready: OutboxEntry[] = [];
  for (const entry of entries) {
    const threadKey = `${entry.environmentId}:${entry.threadId}`;
    if (blockedThreads.has(threadKey)) continue;
    blockedThreads.add(threadKey);
    if (entry.status === "waiting" && isEnvironmentReady(entry.environmentId)) {
      ready.push(entry);
    }
  }
  return ready;
}

/** Plain sends only; see the module comment. */
export function isOutboxEligibleSend(input: {
  readonly isServerThread: boolean;
  readonly hasAttachments: boolean;
  readonly needsBootstrap: boolean;
}): boolean {
  return input.isServerThread && !input.hasAttachments && !input.needsBootstrap;
}
