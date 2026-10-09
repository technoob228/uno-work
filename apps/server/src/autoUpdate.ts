/**
 * Uno Work updates itself on a cloud computer while nobody works on it
 * ("Update automatically", Settings → Computer; on by default).
 *
 * Once a minute the daemon asks itself: is there a newer release the console
 * offers for automatic updates, and is now a good moment? If so it drops a
 * request file next to the Update button's (`auto` instead of `request`,
 * selfUpdate.ts) — the root updater does the rest, puts the previous version
 * back when the new one does not start, and the new daemon tells the console,
 * which writes "Uno Work on this computer was updated to X (was Y)" into
 * Security (selfUpdateJournal.ts: no owner's note, so not "You updated").
 *
 * Which release. The console's SHA256SUMS has two pointers: `latest` (the
 * Update button, every release) and `auto` (release-work.sh moves it a day
 * after latest, when the canary and the first manual updates went fine).
 * The root updater reads nothing the daemon writes; the request's NAME picks
 * the pointer (`auto` → the auto release) and the updater looks it up in the
 * console's list itself, and installs only a newer version. No `auto` line —
 * no automatic updates at all; `release-work.sh auto rollback` moves the
 * pointer back, so machines not yet updated stay where they are.
 *
 * A good moment (all of them):
 *   - no agent turn, no command still running (the economy probe,
 *     EconomyPresence.ts — the same signals that keep the computer awake);
 *   - nothing happened for QUIET_MS: no input in a client, no turn or command,
 *     no daemon start and no wake from economy sleep. Economy sleeps the
 *     computer after 10 minutes of quiet, so the check comes before that; a
 *     computer that just woke up is left alone — someone came to work;
 *   - no reminder due within REMINDER_GAP_MS;
 *   - no update asked for or running already.
 *
 * Not in a loop: a version that was put back (it did not start here) is never
 * tried again automatically; a failed run waits FAILED_RETRY_MS; a request the
 * daemon dropped is not repeated for the same version within ATTEMPT_RETRY_MS.
 * The owner's button works as before in every case.
 */
import { Duration, Effect, Layer, Schedule } from "effect";

import packageJson from "../package.json" with { type: "json" };
import { detectWake } from "./economy/economyReport.ts";
import { EconomyPresence, type EconomyActivity } from "./economy/EconomyPresence.ts";
import { isNewerVersion, type UpdaterStatus } from "./selfUpdate.ts";
import { selfUpdateController } from "./selfUpdateHttp.ts";
import { ServerSettingsService } from "./serverSettings.ts";

export const AUTO_UPDATE_TICK_MS = 60_000;
/** Economy sleeps after 10 minutes of quiet: decide before it. */
export const AUTO_UPDATE_QUIET_MS = 8 * 60_000;
export const AUTO_UPDATE_REMINDER_GAP_MS = 15 * 60_000;
export const AUTO_UPDATE_FAILED_RETRY_MS = 24 * 60 * 60_000;
export const AUTO_UPDATE_ATTEMPT_RETRY_MS = 60 * 60_000;

export type AutoUpdateSkip =
  | "off"
  | "unsupported"
  | "no-auto"
  | "current"
  | "in-progress"
  | "rolled-back"
  | "failed-recently"
  | "attempted"
  | "busy"
  | "recent-activity"
  | "reminder-soon";

export type AutoUpdateDecision =
  | { readonly go: true; readonly version: string }
  | { readonly go: false; readonly reason: AutoUpdateSkip };

export interface AutoUpdateInput {
  readonly now: number;
  /** The owner's "Update automatically" (server setting `autoUpdate`). */
  readonly enabled: boolean;
  /** The installer set up self-update here (0.0.113+, a cloud computer). */
  readonly supported: boolean;
  readonly currentVersion: string;
  readonly autoVersion: string | null;
  /** A request is waiting or the updater is running (controller.inProgress). */
  readonly inProgress: boolean;
  /** The updater's last word (status.json), for the back-off. */
  readonly lastRun: UpdaterStatus | null;
  /** The daemon's own last request, this process. */
  readonly lastAttempt: { readonly version: string; readonly at: number } | null;
  readonly runningTurns: number;
  readonly runningCommands: number;
  /** Earliest reminder (ISO), null — none. */
  readonly nextWakeAt: string | null;
  /** Since when nothing happened (quietSince). */
  readonly quietSince: number;
}

function runTime(run: UpdaterStatus): number {
  const at = Date.parse(run.finishedAt ?? run.updatedAt ?? run.startedAt ?? "");
  return Number.isFinite(at) ? at : Number.NaN;
}

const skip = (reason: AutoUpdateSkip): AutoUpdateDecision => ({ go: false, reason });

/** The rules above, pure. The first reason that says "not now" wins. */
export function decideAutoUpdate(input: AutoUpdateInput): AutoUpdateDecision {
  if (!input.enabled) return skip("off");
  if (!input.supported) return skip("unsupported");
  const target = input.autoVersion;
  if (!target) return skip("no-auto");
  if (!isNewerVersion(target, input.currentVersion)) return skip("current");
  if (input.inProgress) return skip("in-progress");

  const run = input.lastRun;
  if (run && run.state === "failed") {
    // The updater may fail before it learns the version (no network): that
    // failure counts against whatever we would try next.
    const forTarget = run.toVersion === target || run.toVersion === null;
    if (forTarget && run.rolledBack && run.toVersion === target) return skip("rolled-back");
    const at = runTime(run);
    if (forTarget && (!Number.isFinite(at) || input.now - at < AUTO_UPDATE_FAILED_RETRY_MS)) {
      return skip("failed-recently");
    }
  }
  if (
    input.lastAttempt &&
    input.lastAttempt.version === target &&
    input.now - input.lastAttempt.at < AUTO_UPDATE_ATTEMPT_RETRY_MS
  ) {
    return skip("attempted");
  }

  if (input.runningTurns > 0 || input.runningCommands > 0) return skip("busy");
  if (input.now - input.quietSince < AUTO_UPDATE_QUIET_MS) return skip("recent-activity");
  const reminder = input.nextWakeAt ? Date.parse(input.nextWakeAt) : Number.NaN;
  if (Number.isFinite(reminder) && reminder - input.now < AUTO_UPDATE_REMINDER_GAP_MS) {
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

export const AutoUpdateSchedulerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const economy = yield* EconomyPresence;
    const settings = yield* ServerSettingsService;
    const update = selfUpdateController();
    const currentVersion = packageJson.version;
    const startedAt = Date.now();
    let lastTickAt: number | null = null;
    let lastWokeAt: number | null = null;
    let lastBusyAt: number | null = null;
    let lastAttempt: { version: string; at: number } | null = null;
    let lastReason: string | null = null;

    const decide = (activity: EconomyActivity, refresh: boolean, now: number) =>
      Effect.gen(function* () {
        const enabled = yield* settings.getSettings.pipe(
          Effect.map((current) => current.autoUpdate),
          Effect.orElseSucceed(() => false),
        );
        const supported = update.supported;
        // Ask the console only when it can matter (on, supported, quiet).
        const releases =
          enabled && supported
            ? yield* Effect.promise(() => update.releases(refresh))
            : { latest: null, auto: null };
        const [inProgress, lastRun] = yield* Effect.promise(() =>
          Promise.all([update.inProgress(), update.lastRun()]),
        );
        return decideAutoUpdate({
          now,
          enabled,
          supported,
          currentVersion,
          autoVersion: releases.auto?.version ?? null,
          inProgress,
          lastRun,
          lastAttempt,
          runningTurns: activity.runningTurns,
          runningCommands: activity.runningTerminals,
          nextWakeAt: activity.nextWakeAt,
          quietSince: quietSince({
            startedAt,
            lastWokeAt,
            lastInputAt: activity.lastInputAt,
            lastBusyAt,
          }),
        });
      });

    const tick = Effect.gen(function* () {
      const now = Date.now();
      if (detectWake(lastTickAt, now, AUTO_UPDATE_TICK_MS)) lastWokeAt = now;
      lastTickAt = now;
      const activity = yield* economy.activity;
      if (activity.runningTurns > 0 || activity.runningTerminals > 0) lastBusyAt = now;
      let decision = yield* decide(activity, false, now);
      // Before acting, read the list again: `auto` may have moved back or
      // gone (auto rollback / off) since the last read.
      if (decision.go) decision = yield* decide(activity, true, now);
      if (!decision.go) {
        if (decision.reason !== lastReason) {
          lastReason = decision.reason;
          yield* Effect.logDebug("self-update: automatic — not now", { reason: decision.reason });
        }
        return;
      }
      lastAttempt = { version: decision.version, at: now };
      lastReason = null;
      yield* Effect.promise(() => update.requestAutomatic());
      yield* Effect.logInfo("self-update: automatic, nobody is working here", {
        from: currentVersion,
        to: decision.version,
      });
    });

    yield* Effect.forkScoped(
      tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("self-update: automatic check failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(AUTO_UPDATE_TICK_MS))),
      ),
    );
  }),
);
