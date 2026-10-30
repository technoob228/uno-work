/**
 * Read state shared through the daemon, so web Work and the T3 phone app
 * agree (Misha 29.10). Two marks per chat:
 *  - the visit watermark (useUiStateStore.threadLastVisitedAtById — the
 *    unread dot), sent as `thread.visit` / `thread.mark-unread`;
 *  - Work's manual "Read" (threadReadMarks + the sidebar summary's readAt —
 *    "Your turn"), sent as `thread.read`; Mark unread clears both.
 *
 * The browser stores stay the instant local copy the UI renders from; this
 * module only mirrors them:
 *  - out: after a local change, a debounced background write, never awaited
 *    by a click, retried quietly, per chat in order, dropped for daemons
 *    without the commands;
 *  - in: shell snapshots / upserts carry lastVisitedAt, readAt and
 *    readStateUpdatedAt. A visit only ever raises the local watermark (max).
 *    A server decision this browser has not seen yet (readStateUpdatedAt
 *    moved) is adopted as is — that is how "mark unread" on the phone reaches
 *    Work. While this browser has its own change for a chat in flight (and
 *    a few seconds after), server marks for that chat wait, so a late echo
 *    never flips it back; they are re-applied when the chat settles.
 *  - one store write per batch, none when nothing changed;
 *  - no backfill: the visit map is not persisted and Work seeds every chat
 *    as seen on load, so "local visits the server lacks" would only be those
 *    seeds — a burst of one command per chat on every reconnect.
 */
import {
  type EnvironmentId,
  type OrchestrationThreadShell,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";

import { readEnvironmentApi } from "./environmentApi";
import { newCommandId } from "./lib/utils";
import { setThreadReadAtSink, useStore } from "./store";
import { readThreadReadAt } from "./threadReadMarks";
import { setThreadReadStateSink, useUiStateStore } from "./uiStateStore";

const FLUSH_DEBOUNCE_MS = 600;
const FLUSH_BATCH = 4;
const FLUSH_SPACING_MS = 500;
const MAX_ATTEMPTS = 3;
/** After the last local change (or its write) server marks for that chat wait this long. */
const SETTLE_MS = 5_000;

type Op =
  | { readonly kind: "visit"; readonly at: string; readonly attempts: number }
  | { readonly kind: "read"; readonly at: string; readonly attempts: number }
  | { readonly kind: "unread"; readonly attempts: number };

type ServerThread = Pick<
  OrchestrationThreadShell,
  "id" | "lastVisitedAt" | "readAt" | "readStateUpdatedAt" | "latestTurn"
>;

const queues = new Map<string, Op[]>();
const inflight = new Set<string>();
const settleUntil = new Map<string, number>();
/** Latest server row per chat that arrived while the chat was unsettled. */
const deferred = new Map<string, { environmentId: EnvironmentId; thread: ServerThread }>();
/** readStateUpdatedAt of the last server decision taken, per chat. */
const seenVersion = new Map<string, string | null>();
/** Daemons that rejected the commands (older Work): stop sending to them. */
const unsupportedEnvironments = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const toMs = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN);

function isSettled(threadKey: string) {
  return (
    !queues.has(threadKey) &&
    !inflight.has(threadKey) &&
    (settleUntil.get(threadKey) ?? 0) <= Date.now()
  );
}

function touch(threadKey: string) {
  settleUntil.set(threadKey, Date.now() + SETTLE_MS);
  setTimeout(() => replayDeferred(threadKey), SETTLE_MS + 50);
}

function replayDeferred(threadKey: string) {
  if (!isSettled(threadKey)) return;
  const pendingRow = deferred.get(threadKey);
  if (!pendingRow) return;
  deferred.delete(threadKey);
  mergeServerThreadReadState(pendingRow.environmentId, [pendingRow.thread]);
}

function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS) {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, delayMs);
}

function enqueue(threadKey: string, op: Op) {
  const ref = parseScopedThreadKey(threadKey);
  if (!ref || unsupportedEnvironments.has(ref.environmentId)) return;
  touch(threadKey);
  const list = queues.get(threadKey) ?? [];
  // Unread supersedes everything queued before it; a visit / Read replaces an
  // older one of its kind. Order is kept: unread then a visit stays both.
  const next =
    op.kind === "unread"
      ? [op]
      : [
          ...list.filter((queued) => !(queued.kind === op.kind && toMs(queued.at) <= toMs(op.at))),
          op,
        ];
  queues.set(threadKey, next);
  scheduleFlush();
}

function isUnsupportedCommandError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /thread\.(visit|read|mark-unread)|Expected|is not a valid|Unknown/i.test(message);
}

function commandOf(threadId: string, op: Op) {
  const base = { commandId: newCommandId(), threadId: ThreadId.make(threadId) };
  switch (op.kind) {
    case "visit":
      return { ...base, type: "thread.visit" as const, visitedAt: op.at };
    case "read":
      return { ...base, type: "thread.read" as const, readAt: op.at };
    case "unread":
      return { ...base, type: "thread.mark-unread" as const };
  }
}

async function send(threadKey: string, ops: ReadonlyArray<Op>) {
  const ref = parseScopedThreadKey(threadKey);
  const api = ref ? readEnvironmentApi(ref.environmentId) : null;
  if (!ref || !api) return;
  inflight.add(threadKey);
  try {
    for (let index = 0; index < ops.length; index += 1) {
      const op = ops[index]!;
      try {
        await api.orchestration.dispatchCommand(commandOf(ref.threadId, op));
      } catch (error) {
        if (isUnsupportedCommandError(error) && op.attempts === 0) {
          unsupportedEnvironments.add(ref.environmentId);
          return;
        }
        // Quiet retry of what is left, unless something newer was queued.
        const rest = ops
          .slice(index)
          .map((left) => ({ ...left, attempts: left.attempts + 1 }))
          .filter((left) => left.attempts < MAX_ATTEMPTS);
        if (rest.length > 0 && !queues.has(threadKey)) {
          queues.set(threadKey, rest);
          scheduleFlush(FLUSH_DEBOUNCE_MS * 2 ** rest[0]!.attempts);
        }
        return;
      }
    }
  } finally {
    inflight.delete(threadKey);
    touch(threadKey); // the echo of this write lands inside the settle window
  }
}

function flush() {
  let started = 0;
  for (const [threadKey, ops] of queues) {
    if (started >= FLUSH_BATCH) break;
    if (inflight.has(threadKey)) continue;
    queues.delete(threadKey);
    started += 1;
    void send(threadKey, ops);
  }
  if (queues.size > 0) scheduleFlush(FLUSH_SPACING_MS);
}

/** Wire the local stores' Read / visit / unread actions to the server. Idempotent. */
export function installThreadReadStateSync() {
  setThreadReadStateSink({
    visited: (threadKey, visitedAt) =>
      enqueue(threadKey, { kind: "visit", at: visitedAt, attempts: 0 }),
    unread: (threadKey) => enqueue(threadKey, { kind: "unread", attempts: 0 }),
  });
  setThreadReadAtSink((threadRef: ScopedThreadRef, readAt: string | null) => {
    const threadKey = scopedThreadKey(threadRef);
    if (readAt === null) {
      enqueue(threadKey, { kind: "unread", attempts: 0 });
      return;
    }
    // The server moves its visit watermark up to readAt; do the same here so
    // that echo changes nothing (no re-render later).
    const local = useUiStateStore.getState().threadLastVisitedAtById[threadKey];
    if (!(toMs(local) >= toMs(readAt))) {
      useUiStateStore.setState((state) => ({
        threadLastVisitedAtById: { ...state.threadLastVisitedAtById, [threadKey]: readAt },
      }));
    }
    enqueue(threadKey, { kind: "read", at: readAt, attempts: 0 });
  });
}

/**
 * Take server read marks: visits that are newer than the local ones, and
 * server decisions not seen yet (Read / mark unread from another device).
 * One write per store for the whole list; nothing when nothing changed.
 */
export function mergeServerThreadReadState(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<ServerThread>,
) {
  const localVisits = useUiStateStore.getState().threadLastVisitedAtById;
  let visits: Record<string, string> | null = null;
  const readAts: Array<{ threadRef: ScopedThreadRef; readAt: string | null }> = [];
  for (const thread of threads) {
    const threadRef = scopeThreadRef(environmentId, thread.id);
    const threadKey = scopedThreadKey(threadRef);
    if (!isSettled(threadKey)) {
      deferred.set(threadKey, { environmentId, thread });
      continue;
    }
    deferred.delete(threadKey);
    const version = thread.readStateUpdatedAt ?? null;
    const isNewDecision = version !== null && seenVersion.get(threadKey) !== version;
    if (version !== null) seenVersion.set(threadKey, version);

    const localAt = localVisits[threadKey];
    const serverAt = thread.lastVisitedAt ?? null;
    if (serverAt !== null && !(toMs(localAt) >= toMs(serverAt))) {
      visits ??= {};
      visits[threadKey] = serverAt;
    } else if (serverAt === null && isNewDecision) {
      // Marked unread elsewhere: same local mark as Work's own Mark unread.
      const completedMs = toMs(thread.latestTurn?.completedAt);
      if (Number.isFinite(completedMs) && toMs(localAt) >= completedMs) {
        visits ??= {};
        visits[threadKey] = new Date(completedMs - 1).toISOString();
      }
    }

    if (isNewDecision) {
      const serverRead = thread.readAt ?? null;
      if (serverRead !== readThreadReadAt(environmentId, thread.id)) {
        readAts.push({ threadRef, readAt: serverRead });
      }
    }
  }
  if (visits !== null) {
    const patch = visits;
    useUiStateStore.setState((state) => ({
      threadLastVisitedAtById: { ...state.threadLastVisitedAtById, ...patch },
    }));
  }
  if (readAts.length > 0) useStore.getState().applyServerThreadReadAts(readAts);
}

/** Test hook: forget every queue and mark. */
export function resetThreadReadStateSyncForTests() {
  queues.clear();
  inflight.clear();
  settleUntil.clear();
  deferred.clear();
  seenVersion.clear();
  unsupportedEnvironments.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}
