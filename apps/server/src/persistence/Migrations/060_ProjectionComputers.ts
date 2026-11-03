import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Computers lifecycle (CONTRACT §3, §7.6): `projection_projects.computer_json`
 * (the folder on the person's own computer a project stands for, see
 * ProjectComputer) and `projection_threads.computer_wait_json` (a turn waiting
 * for that computer, see ThreadComputerWait). Nullable JSON TEXT; guarded so
 * re-running is a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "computer_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN computer_json TEXT
    `;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "computer_wait_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN computer_wait_json TEXT
    `;
  }
});
