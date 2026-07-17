import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Single-row table exercised by /api/health and the self-watchdog: a real
// write+read through the same SQLite path the event store uses, so a
// half-dead database (locked WAL, read-only file, full disk) turns health
// checks red instead of hiding behind a static 200.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS health_heartbeat (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      probed_at_ms INTEGER NOT NULL
    )
  `;
});
