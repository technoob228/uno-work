/**
 * What the agent itself is doing in a provider session, as opposed to when the
 * person last wrote to the thread (`ProviderSessionDirectory.lastSeenAt`).
 *
 * The reaper used to judge a session by the person's last message alone. An
 * agent that works on its own — a long turn, or a background task such as
 * `Bash run_in_background` / `Monitor` that wakes it with a synthetic turn —
 * looked idle and its harness was stopped, taking the background tasks with
 * it. This module keeps, in memory and per thread, the time of the last
 * runtime event and the set of live background tasks. It is deliberately not
 * persisted: after a daemon restart there is no harness process and so
 * nothing to protect; the reaper falls back to `lastSeenAt`.
 *
 * Fed from `ProviderService.publishRuntimeEvent`, the one place every harness
 * event passes through; read by the reaper and by the live-process cap.
 *
 * @module sessionActivity
 */

/**
 * A background task that never reports completion must not pin a harness
 * (and its memory) for ever. Long enough for an overnight training run.
 */
export const BACKGROUND_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface ThreadActivity {
  lastEventMs: number;
  /** task id → when it started (ms since epoch). */
  readonly backgroundTasks: Map<string, number>;
}

export interface SessionActivity {
  /** Last runtime event of the harness (ms since epoch), if any this run. */
  readonly lastEventMs: number | undefined;
  readonly backgroundTaskCount: number;
}

/** The parts of a runtime event this module looks at. */
export interface ActivityEvent {
  readonly threadId: string;
  readonly type: string;
  readonly payload?: unknown;
}

const activityByThread = new Map<string, ThreadActivity>();

function payloadField(payload: unknown, key: string): unknown {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

/** Notes one runtime event of a harness. Cheap: an in-memory map update. */
export function recordRuntimeEvent(event: ActivityEvent, nowMs: number = Date.now()): void {
  if (event.type === "session.exited") {
    // The harness process is gone, and its background tasks with it.
    activityByThread.delete(event.threadId);
    return;
  }
  let entry = activityByThread.get(event.threadId);
  if (entry === undefined) {
    entry = { lastEventMs: nowMs, backgroundTasks: new Map() };
    activityByThread.set(event.threadId, entry);
  }
  entry.lastEventMs = nowMs;

  const taskId = payloadField(event.payload, "taskId");
  if (typeof taskId !== "string") return;
  if (event.type === "task.started" && payloadField(event.payload, "isBackgrounded") === true) {
    entry.backgroundTasks.set(taskId, nowMs);
  } else if (event.type === "task.completed") {
    entry.backgroundTasks.delete(taskId);
  }
}

/** Forgets a thread whose harness was stopped on purpose. */
export function forgetSessionActivity(threadId: string): void {
  activityByThread.delete(threadId);
}

export function getSessionActivity(threadId: string, nowMs: number = Date.now()): SessionActivity {
  const entry = activityByThread.get(threadId);
  if (entry === undefined) return { lastEventMs: undefined, backgroundTaskCount: 0 };
  for (const [taskId, startedMs] of entry.backgroundTasks) {
    if (nowMs - startedMs > BACKGROUND_TASK_MAX_AGE_MS) entry.backgroundTasks.delete(taskId);
  }
  return { lastEventMs: entry.lastEventMs, backgroundTaskCount: entry.backgroundTasks.size };
}

/**
 * The session's last sign of life: the later of the person's last message and
 * the agent's last event.
 */
export function lastActivityMs(lastSeenMs: number, activity: SessionActivity): number {
  return activity.lastEventMs !== undefined
    ? Math.max(lastSeenMs, activity.lastEventMs)
    : lastSeenMs;
}

/** Test helper. */
export function resetSessionActivity(): void {
  activityByThread.clear();
}
