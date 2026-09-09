/**
 * 040 — re-apply 037 for databases that skipped it.
 *
 * The Uno integration line shipped 038_Workspace and 039_ProjectionThreadsPinned
 * before 037_ProjectionProjectRepositoryIdentity was cherry-picked from
 * upstream. The migrator only runs ids above the latest applied one, so a
 * database that already ran 039 never sees 037 and `projection_projects` lacks
 * the repository identity columns every project query now reads.
 *
 * 037 is idempotent (column existence checks, `CREATE INDEX IF NOT EXISTS`), so
 * running its body again is a no-op everywhere else.
 */
export { default } from "./037_ProjectionProjectRepositoryIdentity.ts";
