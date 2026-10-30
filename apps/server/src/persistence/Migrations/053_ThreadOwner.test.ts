import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ThreadOwner from "./053_ThreadOwner.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("053_ThreadOwner", (it) => {
  it.effect("backfills who started a chat and the person's latest message", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      // A row with every required column filled, whatever the schema adds.
      const columns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: unknown;
      }>`PRAGMA table_info(projection_threads)`;
      const insertThread = (threadId: string, extra: Record<string, unknown> = {}) => {
        const values: Record<string, unknown> = {};
        for (const column of columns) {
          if (column.notnull === 1 && column.dflt_value === null) {
            values[column.name] = column.type.toUpperCase().includes("INT") ? 0 : "x";
          }
        }
        Object.assign(values, { thread_id: threadId }, extra);
        return sql`INSERT INTO projection_threads ${sql.insert(values)}`;
      };
      let sequence = 0;
      const insertEvent = (
        threadId: string,
        type: string,
        payload: Record<string, unknown>,
        origin?: Record<string, unknown>,
      ) => {
        sequence += 1;
        return sql`INSERT INTO orchestration_events ${sql.insert({
          event_id: `event-${sequence}`,
          aggregate_kind: "thread",
          stream_id: threadId,
          stream_version: sequence,
          event_type: type,
          occurred_at: "2026-10-28T10:00:00.000Z",
          actor_kind: "client",
          payload_json: JSON.stringify(payload),
          metadata_json: JSON.stringify(origin ? { origin } : {}),
        })}`;
      };

      yield* insertThread("thread-mine");
      yield* insertEvent("thread-mine", "thread.created", {});
      yield* insertEvent("thread-mine", "thread.message-sent", {
        role: "user",
        createdAt: "2026-10-28T10:01:00.000Z",
      });

      yield* insertThread("thread-agent");
      yield* insertEvent("thread-agent", "thread.created", {}, { kind: "agent", threadId: "p" });
      yield* insertEvent(
        "thread-agent",
        "thread.message-sent",
        { role: "user", createdAt: "2026-10-28T10:02:00.000Z" },
        { kind: "agent", threadId: "p" },
      );
      yield* insertEvent("thread-agent", "thread.message-sent", {
        role: "user",
        createdAt: "2026-10-28T10:03:00.000Z",
      });
      yield* insertEvent(
        "thread-agent",
        "thread.message-sent",
        { role: "user", createdAt: "2026-10-28T10:04:00.000Z" },
        { kind: "connector", connector: "telegram" },
      );

      yield* insertThread("thread-uno");
      yield* insertEvent("thread-uno", "thread.created", {}, { kind: "manager", tokenId: "t" });

      yield* runMigrations({ toMigrationInclusive: 53 });

      const rows = yield* sql<{
        readonly thread_id: string;
        readonly started_by: string | null;
        readonly latest_person_message_at: string | null;
        readonly person_called_at: string | null;
      }>`
        SELECT thread_id, started_by, latest_person_message_at, person_called_at
        FROM projection_threads ORDER BY thread_id
      `;
      assert.deepStrictEqual(rows, [
        {
          thread_id: "thread-agent",
          started_by: "agent",
          latest_person_message_at: "2026-10-28T10:04:00.000Z",
          person_called_at: null,
        },
        {
          thread_id: "thread-mine",
          started_by: null,
          latest_person_message_at: null,
          person_called_at: null,
        },
        {
          thread_id: "thread-uno",
          started_by: "assistant",
          latest_person_message_at: null,
          person_called_at: null,
        },
      ]);
    }),
  );

  // 0.0.164-t3p.x stands: ThreadOwner recorded as 51, then the release's 52 and this 53.
  it.effect("runs again as 53 on a machine that recorded it as 51, keeping its data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE IF EXISTS effect_sql_migrations`;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      `;
      for (const table of tables) {
        yield* sql.unsafe(`DROP TABLE "${table.name}"`);
      }

      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* ThreadOwner;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (51, 'ThreadOwner')
      `;

      const columns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: unknown;
      }>`PRAGMA table_info(projection_threads)`;
      const values: Record<string, unknown> = {};
      for (const column of columns) {
        if (column.notnull === 1 && column.dflt_value === null) {
          values[column.name] = column.type.toUpperCase().includes("INT") ? 0 : "x";
        }
      }
      Object.assign(values, {
        thread_id: "thread-stand",
        started_by: "agent",
        latest_person_message_at: "2026-10-29T10:00:00.000Z",
        person_called_at: "2026-10-29T11:00:00.000Z",
        person_called_by_thread_id: "thread-parent",
        person_call_reason: "look at this",
      });
      yield* sql`INSERT INTO projection_threads ${sql.insert(values)}`;

      const ran = yield* runMigrations();
      assert.deepStrictEqual(
        ran.map(([id]) => id),
        [52, 53],
      );

      const rows = yield* sql`
        SELECT started_by, latest_person_message_at, person_called_at,
          person_called_by_thread_id, person_call_reason, last_visited_at
        FROM projection_threads
      `;
      assert.deepStrictEqual(rows, [
        {
          started_by: "agent",
          latest_person_message_at: "2026-10-29T10:00:00.000Z",
          person_called_at: "2026-10-29T11:00:00.000Z",
          person_called_by_thread_id: "thread-parent",
          person_call_reason: "look at this",
          last_visited_at: null,
        },
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }),
  );
});
