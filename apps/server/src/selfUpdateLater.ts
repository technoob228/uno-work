/**
 * "This evening" next to Update (selfUpdate.ts): the owner agrees to the
 * update that is out, and the computer installs it by itself after that time,
 * at the first moment nothing is running on it. Without the owner's word the
 * daemon never updates by itself — there is no silent mode.
 *
 * The word is a small file next to the daemon's state (it survives a restart):
 * `{ version, notBefore }`. `version` is what the owner was offered; if a
 * newer release is out by the evening, that one is installed — the word is for
 * "the update", and the root updater only ever installs the console's latest.
 * `notBefore` comes from the owner's browser: 20:00 in their time zone, or
 * "now" when it is already later than that.
 *
 * One word — one try. Acting on it (the daemon drops the same request file as
 * the Update button) uses it up, so nothing can loop: after a failed run the
 * owner sees the usual "Uno Work wasn't updated" and decides again. The word
 * also goes away when it has nothing left to say: the owner pressed Update,
 * the computer is already on that version, the release was withdrawn, or the
 * release was tried here and put back (a version that did not start on this
 * computer is never tried again without the owner's Update).
 *
 * The right moment, after `notBefore` (all of them):
 *   - no agent turn, no command still running (the economy probe,
 *     EconomyPresence.ts — the same signals that keep the computer awake);
 *   - nothing happened for QUIET_MS: no input in a client, no turn or command,
 *     no daemon start and no wake from economy sleep;
 *   - no reminder due within REMINDER_GAP_MS;
 *   - no update asked for or running already.
 *
 * A computer on economy may be asleep at `notBefore`: the time goes to the
 * console as the daemon's next alarm (`next_wake_at`, with the reminders), so
 * the console wakes the computer for it. While the daemon is only waiting for
 * the quiet minutes it holds the computer awake ("work:update" in keep_awake),
 * as it does while the updater runs — sleep must not freeze it half-way.
 *
 * Kept free of Effect so tests drive it directly; the loop is in
 * selfUpdateLaterScheduler.ts.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isNewerVersion, type SelfUpdateStatus, type UpdaterStatus } from "./selfUpdate.ts";

export const UPDATE_LATER_TICK_MS = 60_000;
/** "Nothing is running": this long without input, work, a start or a wake-up. */
export const UPDATE_LATER_QUIET_MS = 3 * 60_000;
export const UPDATE_LATER_REMINDER_GAP_MS = 15 * 60_000;
/** "This evening" is at most a day away; a client cannot book next month. */
export const UPDATE_LATER_MAX_AHEAD_MS = 24 * 60 * 60_000;
/** keep_awake while Uno Work updates itself or waits for its moment. */
export const KEEP_AWAKE_UPDATE = "work:update";

const LATER_FILE = "self-update-later.json";
const VERSION = /^\d+\.\d+\.\d+$/;

/** The owner's word. */
export interface UpdateLater {
  /** The release the owner was offered. */
  readonly version: string;
  /** ISO time: not before this. */
  readonly notBefore: string;
}

export function parseUpdateLater(body: string): UpdateLater | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const version = record["version"];
    const notBefore = record["notBefore"];
    if (typeof version !== "string" || !VERSION.test(version)) return null;
    if (typeof notBefore !== "string" || !Number.isFinite(Date.parse(notBefore))) return null;
    return { version, notBefore: new Date(Date.parse(notBefore)).toISOString() };
  } catch {
    return null;
  }
}

export async function readUpdateLater(stateDir: string): Promise<UpdateLater | null> {
  try {
    return parseUpdateLater(await readFile(join(stateDir, LATER_FILE), "utf8"));
  } catch {
    return null;
  }
}

export async function writeUpdateLater(stateDir: string, later: UpdateLater): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, LATER_FILE);
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(later)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function clearUpdateLater(stateDir: string): Promise<void> {
  await rm(join(stateDir, LATER_FILE), { force: true }).catch(() => undefined);
}

/**
 * The time the owner's browser asked for, kept within reason: never in the
 * past (that is "now"), never more than a day ahead. Null — not a time.
 */
export function clampNotBefore(value: unknown, now: number): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Date(Math.min(Math.max(at, now), now + UPDATE_LATER_MAX_AHEAD_MS)).toISOString();
}

/** The latest release was tried on this computer and put back. */
export function rolledBackHere(run: UpdaterStatus | null, version: string | null): boolean {
  return (
    version !== null &&
    run !== null &&
    run.state === "failed" &&
    run.rolledBack &&
    run.toVersion === version
  );
}

/** Whether a stored word still means something for the status the app gets. */
function laterStillStands(later: UpdateLater | null, status: SelfUpdateStatus): UpdateLater | null {
  if (!later || !status.supported) return null;
  // Already on that version or a newer one (the update went through).
  if (!isNewerVersion(later.version, status.currentVersion)) return null;
  // The console's latest is known and is not ahead of this computer: withdrawn.
  if (status.latestVersion !== null && !status.available && status.state !== "updating") {
    return null;
  }
  return later;
}

/** `later` and `laterAvailable` for `GET /api/self-update/status`. */
export function statusWithLater(
  status: SelfUpdateStatus,
  stored: UpdateLater | null,
): SelfUpdateStatus {
  const rolledBack =
    status.state === "failed" && status.rolledBack && status.toVersion === status.latestVersion;
  const later = rolledBack ? null : laterStillStands(stored, status);
  return {
    ...status,
    later,
    laterAvailable: status.supported && status.canUpdate && status.available && !rolledBack,
  };
}

export type UpdateLaterSkip =
  /** Nobody said "This evening". */
  | "not-asked"
  | "unsupported"
  /** The console's list could not be read: next minute. */
  | "no-release"
  /** Nothing newer than this computer is out (done, or withdrawn). */
  | "current"
  | "rolled-back"
  | "not-yet"
  | "in-progress"
  | "busy"
  | "recent-activity"
  | "reminder-soon";

/** Reasons after which the owner's word has nothing left to say. */
export const UPDATE_LATER_FINAL: ReadonlySet<UpdateLaterSkip> = new Set(["current", "rolled-back"]);

export type UpdateLaterDecision =
  | { readonly go: true; readonly version: string }
  | { readonly go: false; readonly reason: UpdateLaterSkip };

export interface UpdateLaterInput {
  readonly now: number;
  /** The owner's "This evening", null — nobody asked. */
  readonly later: UpdateLater | null;
  /** The installer set up self-update here (0.0.113+, a cloud computer). */
  readonly supported: boolean;
  readonly currentVersion: string;
  /** The console's latest release, null — not known right now. */
  readonly latestVersion: string | null;
  /** A request is waiting or the updater is running (controller.inProgress). */
  readonly inProgress: boolean;
  /** The updater's last word (status.json). */
  readonly lastRun: UpdaterStatus | null;
  readonly runningTurns: number;
  readonly runningCommands: number;
  /** Earliest reminder (ISO), null — none. */
  readonly nextReminderAt: string | null;
  /** Since when nothing happened (quietSince). */
  readonly quietSince: number;
}

const skip = (reason: UpdateLaterSkip): UpdateLaterDecision => ({ go: false, reason });

/** The rules above, pure. The first reason that says "not now" wins. */
export function decideUpdateLater(input: UpdateLaterInput): UpdateLaterDecision {
  const later = input.later;
  if (!later) return skip("not-asked");
  if (!input.supported) return skip("unsupported");
  // Already on the version the owner agreed to (or past it).
  if (!isNewerVersion(later.version, input.currentVersion)) return skip("current");
  const target = input.latestVersion;
  if (!target) return skip("no-release");
  // Compared as numbers; never down or sideways.
  if (!isNewerVersion(target, input.currentVersion)) return skip("current");
  if (rolledBackHere(input.lastRun, target)) return skip("rolled-back");
  if (input.now < Date.parse(later.notBefore)) return skip("not-yet");
  if (input.inProgress) return skip("in-progress");
  if (input.runningTurns > 0 || input.runningCommands > 0) return skip("busy");
  if (input.now - input.quietSince < UPDATE_LATER_QUIET_MS) return skip("recent-activity");
  const reminder = input.nextReminderAt ? Date.parse(input.nextReminderAt) : Number.NaN;
  if (
    Number.isFinite(reminder) &&
    reminder > input.now &&
    reminder - input.now < UPDATE_LATER_REMINDER_GAP_MS
  ) {
    return skip("reminder-soon");
  }
  return { go: true, version: target };
}

/** The latest of: daemon start, last wake, last input, last time something ran. */
export function quietSince(input: {
  readonly startedAt: number;
  readonly lastWokeAt: number | null;
  readonly lastInputAt: number | null;
  readonly lastBusyAt: number | null;
}): number {
  return Math.max(
    input.startedAt,
    input.lastWokeAt ?? 0,
    input.lastInputAt ?? 0,
    input.lastBusyAt ?? 0,
  );
}

// ---- What economy mode needs to know (EconomyPresence.ts reads it) ----

export interface UpdateLaterEconomySignals {
  /** Wake the computer for the update at this time (ISO); null — nothing booked ahead. */
  readonly wakeAt: string | null;
  /** The time has come and only the quiet minutes are left: don't fall asleep. */
  readonly holdAwake: boolean;
}

const NO_SIGNALS: UpdateLaterEconomySignals = { wakeAt: null, holdAwake: false };
let economySignals: UpdateLaterEconomySignals = NO_SIGNALS;

export function updateLaterEconomySignals(): UpdateLaterEconomySignals {
  return economySignals;
}

export function setUpdateLaterEconomySignals(signals: UpdateLaterEconomySignals): void {
  economySignals = signals;
}

/** The signals for a word and what the daemon just decided about it. */
export function economySignalsFor(
  later: UpdateLater | null,
  decision: UpdateLaterDecision | null,
  now: number,
): UpdateLaterEconomySignals {
  if (!later) return NO_SIGNALS;
  if (decision && !decision.go && UPDATE_LATER_FINAL.has(decision.reason)) return NO_SIGNALS;
  return {
    wakeAt: Date.parse(later.notBefore) > now ? later.notBefore : null,
    // Bounded: the quiet minutes pass, or someone works (and is awake anyway).
    holdAwake: decision !== null && !decision.go && decision.reason === "recent-activity",
  };
}
