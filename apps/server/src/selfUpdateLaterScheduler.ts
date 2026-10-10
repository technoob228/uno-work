/**
 * The loop behind "This evening" (selfUpdateLater.ts): once a minute, when the
 * owner has agreed to the update, is it time and is nothing running? Then the
 * daemon drops the same request file as the Update button — the root updater
 * does the rest, puts the previous version back when the new one does not
 * start, and the new daemon tells the console, which writes "You updated Uno
 * Work to X (was Y)" into Security: the owner asked for it, so the daemon
 * leaves the owner's note first (selfUpdateJournal.ts), like the button does.
 *
 * Nobody asked — the loop reads one small local file and does nothing else:
 * no network, no request.
 */
import { Duration, Effect, Layer, Schedule } from "effect";

import packageJson from "../package.json" with { type: "json" };
import { ServerConfig } from "./config.ts";
import { detectWake } from "./economy/economyReport.ts";
import { EconomyPresence, type EconomyActivity } from "./economy/EconomyPresence.ts";
import { selfUpdateController } from "./selfUpdateHttp.ts";
import { noteSelfUpdateIntent } from "./selfUpdateJournal.ts";
import {
  UPDATE_LATER_FINAL,
  UPDATE_LATER_TICK_MS,
  clearUpdateLater,
  decideUpdateLater,
  economySignalsFor,
  quietSince,
  readUpdateLater,
  setUpdateLaterEconomySignals,
  type UpdateLater,
} from "./selfUpdateLater.ts";

export const UpdateLaterSchedulerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const economy = yield* EconomyPresence;
    const config = yield* ServerConfig;
    const stateDir = config.stateDir;
    const update = selfUpdateController();
    const currentVersion = packageJson.version;
    const startedAt = Date.now();
    let lastTickAt: number | null = null;
    let lastWokeAt: number | null = null;
    let lastBusyAt: number | null = null;
    let lastReason: string | null = null;

    const decide = (later: UpdateLater, activity: EconomyActivity, refresh: boolean, now: number) =>
      Effect.promise(async () => {
        const [latest, inProgress, lastRun] = await Promise.all([
          update.latest(refresh),
          update.inProgress(),
          update.lastRun(),
        ]);
        return decideUpdateLater({
          now,
          later,
          supported: update.supported,
          currentVersion,
          latestVersion: latest?.version ?? null,
          inProgress,
          lastRun,
          runningTurns: activity.runningTurns,
          runningCommands: activity.runningTerminals,
          nextReminderAt: activity.nextReminderAt,
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
      if (detectWake(lastTickAt, now, UPDATE_LATER_TICK_MS)) lastWokeAt = now;
      lastTickAt = now;
      const later = yield* Effect.promise(() => readUpdateLater(stateDir));
      if (!later) {
        setUpdateLaterEconomySignals(economySignalsFor(null, null, now));
        lastReason = null;
        return;
      }
      const activity = yield* economy.activity;
      if (activity.runningTurns > 0 || activity.runningTerminals > 0) lastBusyAt = now;
      let decision = yield* decide(later, activity, false, now);
      // Before acting, read the console's list again: the release may have
      // been withdrawn since the last read.
      if (decision.go) decision = yield* decide(later, activity, true, now);
      setUpdateLaterEconomySignals(economySignalsFor(later, decision, now));
      if (!decision.go) {
        if (UPDATE_LATER_FINAL.has(decision.reason)) {
          yield* Effect.promise(() => clearUpdateLater(stateDir));
          yield* Effect.logInfo("self-update: 'this evening' is over", {
            reason: decision.reason,
            asked: later.version,
          });
          lastReason = null;
          return;
        }
        if (decision.reason !== lastReason) {
          lastReason = decision.reason;
          yield* Effect.logDebug("self-update: this evening — not now", {
            reason: decision.reason,
          });
        }
        return;
      }
      lastReason = null;
      const version = decision.version;
      // One word — one try: whatever happens to the request, the word is used up.
      const asked = yield* Effect.promise(async () => {
        try {
          // The note first: the updater may start before `request()` returns.
          await noteSelfUpdateIntent(stateDir).catch(() => undefined);
          await update.request();
          return true;
        } catch {
          return false;
        } finally {
          await clearUpdateLater(stateDir);
        }
      });
      if (!asked) {
        yield* Effect.logWarning("self-update: this evening — could not write the request");
        return;
      }
      yield* Effect.logInfo("self-update: as the owner asked, nothing is running here", {
        from: currentVersion,
        to: version,
        notBefore: later.notBefore,
      });
    });

    yield* Effect.forkScoped(
      tick.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("self-update: 'this evening' check failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(UPDATE_LATER_TICK_MS))),
      ),
    );
  }),
);
