/**
 * When the daemon itself asks for an update. Two cases, nothing else:
 *
 * 1. "This evening" (selfUpdateLater.ts) — the loop below: once a minute, when the
 * owner has agreed to the update, is it time and is nothing running? Then the
 * daemon drops the same request file as the Update button — the root updater
 * does the rest, puts the previous version back when the new one does not
 * start, and the new daemon tells the console, which writes "You updated Uno
 * Work to X (was Y)" into Security: the owner asked for it, so the daemon
 * leaves the owner's note first (selfUpdateJournal.ts), like the button does.
 *
 *    Nobody asked — the loop reads one small local file and does nothing
 *    else: no network, no request.
 *
 * 2. A new computer nobody has opened yet (selfUpdateFresh.ts): at daemon
 *    start and when a clone of the image gets its identity, the latest release
 *    is installed at once. The first client connection closes this for good.
 */
import { Duration, Effect, Layer, Option, Queue, Schedule, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import packageJson from "../package.json" with { type: "json" };
import { SessionCredentialService } from "./auth/Services/SessionCredentialService.ts";
import { onCloneIdentityRotated } from "./cloneIdentity.ts";
import { ServerConfig } from "./config.ts";
import { detectWake } from "./economy/economyReport.ts";
import { EconomyPresence, type EconomyActivity } from "./economy/EconomyPresence.ts";
import {
  FRESH_UPDATE_RETRY_MS,
  FRESH_UPDATE_TRIES,
  decideFreshUpdate,
  freshUpdateWorthRetry,
  isNewComputer,
  markOpenedOnce,
  noteFreshAttempt,
  readFreshAttempt,
  wasOpenedOnce,
  type FreshUpdateDecision,
} from "./selfUpdateFresh.ts";
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

    // ---- A new computer nobody has opened yet ----

    const sessions = yield* SessionCredentialService;
    const sql = Option.getOrUndefined(yield* Effect.serviceOption(SqlClient.SqlClient));

    // The first client connection, whenever it comes: from then on only the
    // owner's word updates this computer.
    yield* sessions.streamChanges.pipe(
      Stream.runForEach((change) =>
        change.type === "clientUpserted" && change.clientSession.connected
          ? Effect.promise(() => markOpenedOnce(stateDir).catch(() => undefined))
          : Effect.void,
      ),
      Effect.forkScoped,
    );

    /** A message from a person or an agent turn; null — the tables are not there yet. */
    const hasChats: Effect.Effect<boolean | null> = sql
      ? Effect.gen(function* () {
          const messages = yield* sql<{
            readonly one: number;
          }>`SELECT 1 AS one FROM projection_thread_messages WHERE role = 'user' LIMIT 1`;
          if (messages.length > 0) return true;
          const turns = yield* sql<{
            readonly one: number;
          }>`SELECT 1 AS one FROM projection_turns LIMIT 1`;
          return turns.length > 0;
        }).pipe(Effect.orElseSucceed((): boolean | null => null))
      : Effect.succeed(null);

    const openedOnce = Effect.gen(function* () {
      if (yield* Effect.promise(() => wasOpenedOnce(stateDir))) return true;
      // A computer that was in use before this marker existed: its sessions say so.
      const connected = yield* sessions.listActive().pipe(
        Effect.map((rows) => rows.some((row) => row.connected || row.lastConnectedAt !== null)),
        Effect.orElseSucceed(() => false),
      );
      if (connected) yield* Effect.promise(() => markOpenedOnce(stateDir).catch(() => undefined));
      return connected;
    });

    const freshLook: Effect.Effect<FreshUpdateDecision> = Effect.gen(function* () {
      const supported = update.supported;
      const isNew = supported
        ? yield* Effect.promise(() => isNewComputer(config.environmentIdPath))
        : false;
      const opened = isNew ? yield* openedOnce : true;
      const chats = opened ? true : yield* hasChats;
      // The console is asked only when it can matter.
      const mayMatter = supported && isNew && !opened && chats === false;
      const [latest, inProgress, lastRun, attemptedVersion] = yield* Effect.promise(() =>
        Promise.all([
          mayMatter ? update.latest(true) : Promise.resolve(null),
          mayMatter ? update.inProgress() : Promise.resolve(false),
          mayMatter ? update.lastRun() : Promise.resolve(null),
          mayMatter ? readFreshAttempt(stateDir) : Promise.resolve(null),
        ]),
      );
      const decision = decideFreshUpdate({
        supported,
        isNew,
        openedOnce: opened,
        hasChats: chats,
        currentVersion,
        latestVersion: latest?.version ?? null,
        inProgress,
        lastRun,
        attemptedVersion,
      });
      if (!decision.go) return decision;
      // One try per version: the note first, whatever happens to the request.
      // No owner's note (selfUpdateJournal.ts): Security says "Uno Work on
      // this computer was updated", not "You updated".
      const asked = yield* Effect.promise(async () => {
        try {
          await noteFreshAttempt(stateDir, decision.version);
          await update.request();
          return true;
        } catch {
          return false;
        }
      });
      if (asked) {
        yield* Effect.logInfo("self-update: a new computer nobody has opened yet", {
          from: currentVersion,
          to: decision.version,
        });
      } else {
        yield* Effect.logWarning("self-update: new computer — could not write the request");
      }
      return decision;
    });

    const freshWindow = Effect.gen(function* () {
      for (let attempt = 0; attempt < FRESH_UPDATE_TRIES; attempt += 1) {
        const decision = yield* freshLook;
        if (!freshUpdateWorthRetry(decision)) {
          if (!decision.go) {
            yield* Effect.logDebug("self-update: new computer — nothing to do", {
              reason: decision.reason,
            });
          }
          return;
        }
        yield* Effect.sleep(Duration.millis(FRESH_UPDATE_RETRY_MS));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("self-update: new computer check failed", { cause }),
      ),
    );

    // Daemon start (a cold first boot), then every time a clone of the image's
    // snapshot gets its own identity (cloneIdentity.ts).
    const cloned = yield* Queue.unbounded<void>();
    const stopListening = onCloneIdentityRotated(() => {
      Queue.offerUnsafe(cloned, undefined);
    });
    yield* Effect.addFinalizer(() => Effect.sync(stopListening));
    yield* freshWindow.pipe(
      Effect.flatMap(() =>
        Queue.take(cloned).pipe(
          Effect.flatMap(() => freshWindow),
          Effect.forever,
        ),
      ),
      Effect.forkScoped,
    );

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
