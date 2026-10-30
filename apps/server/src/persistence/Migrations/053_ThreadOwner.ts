import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Who a chat answers to (28.10, the sidebar's "Mine" filter), on
 * `projection_threads`:
 * - `started_by` — who created the chat, from the origin of its
 *   `thread.created` event (see `startedByFromOrigin`);
 * - `latest_person_message_at` — the latest user-role message the person
 *   wrote (no origin, or a Telegram / Slack connector);
 * - `person_called_at`, `person_called_by_thread_id`, `person_call_reason` —
 *   an agent asked the person to look at the chat (`thread.person-called`).
 * Nullable TEXT, guarded so re-running is a no-op. The first two are
 * backfilled from the event log with the projection's own rules; the person
 * call is new, nothing to backfill.
 *
 * Number 053, after 052 from release 0.0.167: the migrator never goes back to
 * a lower id. Stage machines on 0.0.164-t3p.x already ran this as 51, so here
 * it runs a second time: existing columns are skipped and the backfill only
 * fills NULLs, so what they have is kept.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const has = (name: string) => threadColumns.some((column) => column.name === name);
  if (!has("started_by")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN started_by TEXT`;
  }
  if (!has("latest_person_message_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN latest_person_message_at TEXT`;
  }
  if (!has("person_called_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN person_called_at TEXT`;
  }
  if (!has("person_called_by_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN person_called_by_thread_id TEXT`;
  }
  if (!has("person_call_reason")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN person_call_reason TEXT`;
  }

  yield* sql`
    UPDATE projection_threads
    SET started_by = (
      SELECT
        CASE json_extract(events.metadata_json, '$.origin.kind')
          WHEN 'agent' THEN 'agent'
          WHEN 'manager' THEN 'assistant'
          WHEN 'assistant' THEN 'assistant'
          WHEN 'app' THEN 'app'
          WHEN 'plugin' THEN 'app'
          ELSE NULL
        END
      FROM orchestration_events AS events
      WHERE events.aggregate_kind = 'thread'
        AND events.stream_id = projection_threads.thread_id
        AND events.event_type = 'thread.created'
      ORDER BY events.sequence ASC
      LIMIT 1
    )
    WHERE started_by IS NULL
  `;

  // Only chats an agent started read it (the person's own chats are theirs).
  yield* sql`
    UPDATE projection_threads
    SET latest_person_message_at = (
      SELECT MAX(json_extract(events.payload_json, '$.createdAt'))
      FROM orchestration_events AS events
      WHERE events.aggregate_kind = 'thread'
        AND events.stream_id = projection_threads.thread_id
        AND events.event_type = 'thread.message-sent'
        AND json_extract(events.payload_json, '$.role') = 'user'
        AND (
          json_extract(events.metadata_json, '$.origin.kind') IS NULL
          OR json_extract(events.metadata_json, '$.origin.kind') = 'connector'
        )
    )
    WHERE latest_person_message_at IS NULL
      AND (
        started_by IS NOT NULL
        OR spawned_by_thread_id IS NOT NULL
        OR assistant_role = 'spawned'
      )
  `;
});
