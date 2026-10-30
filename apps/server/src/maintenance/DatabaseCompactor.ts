/**
 * Runs compaction in the background: first a while after start, then every few
 * hours. Each step is a small transaction with a pause after it, on the
 * server's own connection, so a chat never waits on it for long.
 *
 * `UNO_WORK_DB_COMPACTION=off` turns it off.
 */
import { Cause, Context, Effect, Layer, Schedule } from "effect";
import type { Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ORCHESTRATION_PROJECTOR_NAMES } from "../orchestration/Layers/ProjectionPipeline.ts";
import { runCompactionPass, shrinkIncrementally } from "./databaseCompaction.ts";

const FIRST_PASS_DELAY = "5 minutes";
const PASS_INTERVAL = "6 hours";
const BATCH_PAUSE = "40 millis";

export const PROJECTOR_COUNT = Object.keys(ORCHESTRATION_PROJECTOR_NAMES).length;

export interface DatabaseCompactorShape {
  /** Must run in a scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class DatabaseCompactor extends Context.Service<DatabaseCompactor, DatabaseCompactorShape>()(
  "t3/maintenance/DatabaseCompactor",
) {}

export const DatabaseCompactorLive = Layer.effect(
  DatabaseCompactor,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pause = Effect.sleep(BATCH_PAUSE);

    const pass = Effect.gen(function* () {
      const result = yield* runCompactionPass(sql, {
        now: Date.now(),
        pause,
        projectorCount: PROJECTOR_COUNT,
      });
      yield* shrinkIncrementally(sql, pause);
      if (result.foldedMessages + result.removedActivityEvents > 0) {
        yield* Effect.logInfo("database compaction: pass done").pipe(Effect.annotateLogs(result));
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("database compaction failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
      ),
    );

    const start: DatabaseCompactorShape["start"] = () =>
      process.env.UNO_WORK_DB_COMPACTION === "off"
        ? Effect.void
        : Effect.sleep(FIRST_PASS_DELAY).pipe(
            Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(PASS_INTERVAL)))),
            Effect.forkScoped,
            Effect.asVoid,
          );

    return { start } satisfies DatabaseCompactorShape;
  }),
);
