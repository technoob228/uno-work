/**
 * Read state (which chats are unread) shared through the daemon, so web Work
 * and the T3 phone app agree (Misha 29.10). The browser store
 * (useUiStateStore.threadLastVisitedAtById) stays the instant local copy the
 * sidebar renders from; this module only mirrors it to and from the server:
 *
 *  - out: after the local store changed (open a chat / mark unread), a
 *    debounced background `thread.visit` / `thread.mark-unread` — never
 *    awaited by a click, retried quietly, dropped for daemons without it;
 *  - in: shell snapshots / upserts carry `lastVisitedAt`; a server value is
 *    taken only when it is NEWER than the local one (max), in one store write,
 *    so an echo can never flip a chat back to unread and an unchanged value
 *    costs no render;
 *  - no backfill: the local map is not persisted and Work seeds every chat
 *    as seen on load (updatedAt), so "local visits the server lacks" would
 *    only ever be those seeds — a burst of one command per chat on every
 *    reconnect. Real visits reach the server live through the sink.
 */
import { type EnvironmentId, type OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";

import { readEnvironmentApi } from "./environmentApi";
import { newCommandId } from "./lib/utils";
import { setThreadReadStateSink, useUiStateStore } from "./uiStateStore";

const FLUSH_DEBOUNCE_MS = 600;
const FLUSH_BATCH = 4;
const FLUSH_SPACING_MS = 500;
const MAX_ATTEMPTS = 3;

type PendingWrite =
  | { readonly kind: "visit"; readonly visitedAt: string; readonly attempts: number }
  | { readonly kind: "unread"; readonly attempts: number };

const pending = new Map<string, PendingWrite>();
/** Chats marked unread here moments ago: a late echo of the older server
 *  visit must not flip them back to read before mark-unread lands. */
const UNREAD_GUARD_MS = 10_000;
const unreadGuardUntil = new Map<string, number>();
/** Daemons that rejected thread.visit (older Work): stop sending to them. */
const unsupportedEnvironments = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const toMs = (value: string | null | undefined) => {
  if (!value) return Number.NaN;
  return Date.parse(value);
};

function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS) {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, delayMs);
}

function queue(threadKey: string, write: PendingWrite) {
  const ref = parseScopedThreadKey(threadKey);
  if (!ref || unsupportedEnvironments.has(ref.environmentId)) return;
  const existing = pending.get(threadKey);
  // Keep the newest intent; a visit only replaces an older visit.
  if (
    existing?.kind === "visit" &&
    write.kind === "visit" &&
    toMs(existing.visitedAt) >= toMs(write.visitedAt)
  ) {
    return;
  }
  pending.set(threadKey, write);
  scheduleFlush();
}

function isUnsupportedCommandError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /thread\.visit|thread\.mark-unread|Expected|is not a valid|Unknown/i.test(message);
}

function flush() {
  const batch = [...pending.entries()].slice(0, FLUSH_BATCH);
  for (const [threadKey, write] of batch) {
    pending.delete(threadKey);
    const ref = parseScopedThreadKey(threadKey);
    if (!ref) continue;
    const api = readEnvironmentApi(ref.environmentId);
    if (!api) continue;
    const command =
      write.kind === "visit"
        ? {
            type: "thread.visit" as const,
            commandId: newCommandId(),
            threadId: ThreadId.make(ref.threadId),
            visitedAt: write.visitedAt,
          }
        : {
            type: "thread.mark-unread" as const,
            commandId: newCommandId(),
            threadId: ThreadId.make(ref.threadId),
          };
    void api.orchestration.dispatchCommand(command).catch((error: unknown) => {
      if (isUnsupportedCommandError(error) && write.attempts === 0) {
        unsupportedEnvironments.add(ref.environmentId);
        return;
      }
      if (write.attempts + 1 >= MAX_ATTEMPTS) return;
      // Quiet retry unless something newer was queued meanwhile.
      if (!pending.has(threadKey)) {
        pending.set(threadKey, { ...write, attempts: write.attempts + 1 });
        scheduleFlush(FLUSH_DEBOUNCE_MS * 2 ** (write.attempts + 1));
      }
    });
  }
  if (pending.size > 0) scheduleFlush(FLUSH_SPACING_MS);
}

/** Wire the local store's visit / unread actions to the server. Idempotent. */
export function installThreadReadStateSync() {
  setThreadReadStateSink({
    visited: (threadKey, visitedAt) =>
      queue(threadKey, { kind: "visit", visitedAt, attempts: 0 }),
    unread: (threadKey) => {
      unreadGuardUntil.set(threadKey, Date.now() + UNREAD_GUARD_MS);
      queue(threadKey, { kind: "unread", attempts: 0 });
    },
  });
}

/**
 * Take server read marks that are newer than the local ones (one store write
 * for the whole list; nothing when nothing is newer).
 */
export function mergeServerThreadReadState(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<Pick<OrchestrationThreadShell, "id" | "lastVisitedAt">>,
) {
  const local = useUiStateStore.getState().threadLastVisitedAtById;
  let newer: Record<string, string> | null = null;
  for (const thread of threads) {
    const threadKey = scopedThreadKey(scopeThreadRef(environmentId, thread.id));
    const localAt = local[threadKey];
    const serverAt = thread.lastVisitedAt ?? null;
    const localMs = toMs(localAt);
    const serverMs = toMs(serverAt);
    const guard = unreadGuardUntil.get(threadKey);
    if (guard !== undefined) {
      if (guard > Date.now() || pending.get(threadKey)?.kind === "unread") continue;
      unreadGuardUntil.delete(threadKey);
    }
    if (serverAt !== null && Number.isFinite(serverMs) && !(localMs >= serverMs)) {
      newer ??= {};
      newer[threadKey] = serverAt;
    }
  }
  if (newer !== null) {
    const patch = newer;
    useUiStateStore.setState((state) => ({
      threadLastVisitedAtById: { ...state.threadLastVisitedAtById, ...patch },
    }));
  }
}
