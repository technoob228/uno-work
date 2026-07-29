/**
 * 037 — persist each project's resolved `RepositoryIdentity`.
 *
 * Identity used to be resolved live from `git remote -v` behind a 60-second
 * cache and never stored. Two consequences this migration removes:
 *
 * 1. A transiently `null` identity makes `deriveLogicalProjectKey` fall back to
 *    the physical key, so a cross-environment project group visibly falls apart
 *    and reassembles.
 * 2. A workspace peer cannot run `git` against our disk, so without a stored
 *    canonical key there is no join key to group work across environments by
 *    repository, and nothing to derive a claim key from.
 *
 * Semantics are last-known-good: writers must never overwrite a non-null
 * identity with null. A repository that momentarily fails to resolve (git not
 * on PATH, a network mount asleep) keeps its previous answer.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("repository_identity_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN repository_identity_json TEXT
    `;
  }
  if (!columnNames.has("repository_canonical_key")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN repository_canonical_key TEXT
    `;
  }
  if (!columnNames.has("repository_identity_resolved_at")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN repository_identity_resolved_at TEXT
    `;
  }

  // Partial index: the overwhelming majority of lookups are "which projects
  // share this repository", and rows without an identity never answer that.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_projects_repository_canonical_key
    ON projection_projects(repository_canonical_key)
    WHERE repository_canonical_key IS NOT NULL
  `;
});
