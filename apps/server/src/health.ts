import { Context, Duration, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { describeSqlCause, PersistenceSqlError } from "./persistence/Errors.ts";

const HEALTH_PROBE_TIMEOUT = Duration.seconds(3);

export class HealthProbeError extends Schema.TaggedErrorClass<HealthProbeError>()(
  "HealthProbeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Health probe failed: ${this.detail}`;
  }
}

/**
 * Proves the database can still be written and read back, through the same
 * SQLite client the event store uses. HTTP 200 from a static route says
 * nothing about persistence — this is what turns a half-dead daemon (locked
 * WAL, read-only file, full disk) into a red health check. Bounded so a
 * wedged database yields a failure, not a hang.
 */
export const runHealthHeartbeatProbe: Effect.Effect<
  number,
  HealthProbeError | PersistenceSqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = Date.now();
  yield* sql`
    INSERT INTO health_heartbeat (id, probed_at_ms)
    VALUES (1, ${now})
    ON CONFLICT (id) DO UPDATE SET probed_at_ms = ${now}
  `.pipe(
    Effect.mapError(
      (cause) =>
        new PersistenceSqlError({
          operation: "health.heartbeat:write",
          detail: `Failed to write health heartbeat: ${describeSqlCause(cause)}`,
          cause,
        }),
    ),
  );
  const rows = yield* sql`SELECT probed_at_ms FROM health_heartbeat WHERE id = 1`.pipe(
    Effect.mapError(
      (cause) =>
        new PersistenceSqlError({
          operation: "health.heartbeat:read",
          detail: `Failed to read health heartbeat back: ${describeSqlCause(cause)}`,
          cause,
        }),
    ),
  );
  const probedAt = rows[0]?.["probed_at_ms"];
  if (Number(probedAt) !== now) {
    return yield* new HealthProbeError({
      detail: `heartbeat read-back mismatch (wrote ${now}, read ${String(probedAt)})`,
    });
  }
  return now;
}).pipe(
  Effect.timeoutOrElse({
    duration: HEALTH_PROBE_TIMEOUT,
    orElse: () =>
      Effect.fail(
        new HealthProbeError({
          detail: `database did not answer within ${Duration.toMillis(HEALTH_PROBE_TIMEOUT)}ms`,
        }),
      ),
  }),
);

export interface HealthCheckShape {
  readonly probe: Effect.Effect<number, HealthProbeError | PersistenceSqlError>;
}

/**
 * Service wrapper so HTTP routes (and the watchdog) can run the probe without
 * dragging SqlClient into the route context.
 */
export class HealthCheck extends Context.Service<HealthCheck, HealthCheckShape>()(
  "t3/HealthCheck",
) {
  static readonly layer = Layer.effect(
    HealthCheck,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return HealthCheck.of({
        probe: runHealthHeartbeatProbe.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      });
    }),
  );
}
