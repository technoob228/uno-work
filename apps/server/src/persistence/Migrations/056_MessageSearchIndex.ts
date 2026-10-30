import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createMessageSearchIndex } from "../../search/messageSearchIndex.ts";

/**
 * The index behind ⌘K and ⌘F. Only the empty index and its triggers here:
 * existing messages are added in the background, so a large database does not
 * hold startup. An SQLite without FTS5 trigrams skips this and search scans.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* createMessageSearchIndex(sql);
});
