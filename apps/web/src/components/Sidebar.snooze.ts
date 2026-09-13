// Snooze rules for the sidebar inbox. Ported from upstream T3 Code
// (packages/client-runtime/src/state/threadSettled.ts + Sidebar.snooze.ts),
// adapted to our SidebarThreadSummary shape and plain-language copy.
import type { SidebarThreadSummary } from "../types";

const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the window is a failed
 * start (or stale data), not pending work.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * MINUTE_MS;

export type ThreadSnoozeInput = Pick<
  SidebarThreadSummary,
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
>;

/** The agent is blocked on the person: an approval or a question is open. */
export function threadNeedsUser(
  thread: Pick<SidebarThreadSummary, "hasPendingApprovals" | "hasPendingUserInput">,
): boolean {
  return thread.hasPendingApprovals || thread.hasPendingUserInput;
}

/**
 * A snoozed thread "raises its hand" when something happens that outranks the
 * snooze: the agent is blocked on the person, the session failed after the
 * snooze was set, or a run finished after the snooze was set. Raising a hand
 * does not clear the server-side fields; it only stops the thread from
 * classifying as snoozed. (The server additionally clears the snooze when a
 * new turn is requested or an approval / input request arrives.)
 */
export function threadRaisedHandWhileSnoozed(thread: ThreadSnoozeInput): boolean {
  if (threadNeedsUser(thread)) return true;
  const snoozedAtMs = thread.snoozedAt == null ? Number.NaN : Date.parse(thread.snoozedAt);
  if (thread.session?.status === "error") {
    if (Number.isNaN(snoozedAtMs)) return true;
    if (Date.parse(thread.session.updatedAt) > snoozedAtMs) return true;
  }
  const completedAt = thread.latestTurn?.completedAt;
  if (
    !Number.isNaN(snoozedAtMs) &&
    thread.latestTurn?.state === "completed" &&
    completedAt != null &&
    Date.parse(completedAt) > snoozedAtMs
  ) {
    return true;
  }
  return false;
}

/**
 * Snoozed: hidden from the inbox while the wake time is in the future and the
 * thread has not raised its hand. Timer wakes are derived on read: no event
 * fires when snoozedUntil passes, the stale fields just stop classifying.
 */
export function isThreadSnoozed(thread: ThreadSnoozeInput, now: string): boolean {
  if (thread.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(thread.snoozedUntil);
  // Malformed data never hides a thread.
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(now)) return false;
  return !threadRaisedHandWhileSnoozed(thread);
}

/**
 * A user message no turn has picked up yet: strictly newer than every
 * timestamp on the latest turn and inside the adoption grace window.
 */
export function hasQueuedTurnStart(
  thread: Pick<SidebarThreadSummary, "latestUserMessageAt" | "latestTurn" | "session">,
  now: string,
): boolean {
  if (thread.latestUserMessageAt == null) return false;
  if (thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(messageAt) || Number.isNaN(nowMs)) return false;
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = thread.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * Snooze is allowed unless the agent is blocked on the person (hiding an
 * approval defeats it) or a just-sent message has not been picked up yet.
 * A running thread IS snoozable: snooze only affects visibility. Client twin
 * of the server invariants so the menu can grey the action out.
 */
export function canSnoozeThread(
  thread: Pick<
    SidebarThreadSummary,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  now: string,
): boolean {
  return !threadNeedsUser(thread) && !hasQueuedTurnStart(thread, now);
}

export type SnoozePresetId = "hour" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** ISO wake time. */
  readonly snoozedUntil: string;
}

function atLocalHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed offsets land on the
// wrong local day across DST transitions.
function addLocalDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * "Snooze until" choices. "This evening" is offered only while evening is
 * more than an hour away. On Sundays "Tomorrow morning" and "Next week" land
 * on the same Monday morning, so only "Tomorrow morning" is offered.
 */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "1 hour",
      snoozedUntil: new Date(now.getTime() + HOUR_MS).toISOString(),
    },
  ];
  const evening = atLocalHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({ id: "evening", label: "This evening", snoozedUntil: evening.toISOString() });
  }
  const tomorrow = atLocalHour(addLocalDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow morning",
    snoozedUntil: tomorrow.toISOString(),
  });
  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atLocalHour(addLocalDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({ id: "next-week", label: "Next week", snoozedUntil: nextWeek.toISOString() });
  }
  return presets;
}

/**
 * Compact "wakes in" label for snoozed rows: "45m", "3h", "2d". Minutes round
 * up so a still-hidden snooze never reads "0m".
 */
export function snoozeWakeLabel(snoozedUntil: string, now: string): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(now);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / MINUTE_MS))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

/**
 * Human wake time for tooltips and toasts: "17:30" (today), "tomorrow 9:00",
 * "Mon 9:00", "Sep 30, 9:00".
 */
export function snoozeWakeDescription(snoozedUntil: string, now: Date): string {
  const wake = new Date(snoozedUntil);
  if (Number.isNaN(wake.getTime())) return "";
  const time = wake.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta <= 0) return time;
  if (dayDelta === 1) return `tomorrow ${time}`;
  if (dayDelta < 7) return `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  return `${wake.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * Parse a `<input type="datetime-local">` value ("2026-09-13T18:30") as local
 * time and return an ISO wake time, or null when it is malformed or not in
 * the future.
 */
export function parseSnoozePickerValue(value: string, now: Date): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const wake = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    0,
    0,
  );
  if (Number.isNaN(wake.getTime()) || wake.getTime() <= now.getTime()) return null;
  return wake.toISOString();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `<input type="datetime-local">` value for a Date, in local time. */
export function formatSnoozePickerValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
