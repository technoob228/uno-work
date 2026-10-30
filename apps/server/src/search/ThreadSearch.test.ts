import type { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { backfillMessageSearchBatch, countUnindexedMessages } from "./messageSearchIndex.ts";
import { ThreadSearch, ThreadSearchLive } from "./ThreadSearch.ts";

const layer = it.layer(ThreadSearchLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const AT = "2026-10-30T10:00:00.000Z";
const threadId = (id: string) => id as ThreadId;

const addThread = (id: string, options: { readonly deletedAt?: string } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      )
      VALUES ('project-1', 'Project', '/tmp/p', '[]', ${AT}, ${AT})
      ON CONFLICT (project_id) DO NOTHING
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, pending_approval_count, pending_user_input_count,
        has_actionable_proposed_plan, deleted_at
      )
      VALUES (
        ${id}, 'project-1', ${id}, '{"provider":"codex","model":"m"}', 'approval-required',
        'default', ${AT}, ${AT}, 0, 0, 0, ${options.deletedAt ?? null}
      )
    `;
  });

const addMessage = (
  id: string,
  thread: string,
  text: string,
  options: {
    readonly role?: string;
    readonly streaming?: boolean;
    readonly createdAt?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (
        ${id}, ${thread}, ${options.role ?? "assistant"}, ${text},
        ${options.streaming ? 1 : 0}, ${options.createdAt ?? AT}, ${options.createdAt ?? AT}
      )
      ON CONFLICT (message_id) DO UPDATE SET
        text = excluded.text,
        is_streaming = excluded.is_streaming,
        updated_at = excluded.updated_at
    `;
  });

const runBackfill = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let cursor: number | null = 0;
  while (cursor !== null) cursor = yield* backfillMessageSearchBatch(sql, cursor);
});

const search = (query: string) =>
  Effect.flatMap(ThreadSearch.asEffect(), (service) => service.search({ query }));
const find = (thread: string, query: string) =>
  Effect.flatMap(ThreadSearch.asEffect(), (service) =>
    service.findInThread({ threadId: threadId(thread), query }),
  );

layer("ThreadSearch", (it) => {
  it.effect("finds a finished message, in any case and in Russian, with its chat", () =>
    Effect.gen(function* () {
      yield* addThread("t-find");
      yield* addMessage("m-ru", "t-find", "Вчера мы обсуждали деплой на Hostkey и ключи.");
      const { matches } = yield* search("ДЕПЛОЙ");
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0]?.threadId, threadId("t-find"));
      assert.strictEqual(matches[0]?.messageId as string, "m-ru");
      assert.ok(matches[0]?.snippet.includes("деплой"));
      assert.strictEqual(matches[0]?.quality, 1);
    }),
  );

  it.effect("keeps a streaming message out until it finishes", () =>
    Effect.gen(function* () {
      yield* addThread("t-stream");
      yield* addMessage("m-stream", "t-stream", "partial zanzibar", { streaming: true });
      assert.strictEqual((yield* search("zanzibar")).matches.length, 0);
      yield* addMessage("m-stream", "t-stream", "final zanzibar answer");
      assert.strictEqual((yield* search("zanzibar")).matches.length, 1);
    }),
  );

  it.effect("follows edits and deletes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* addThread("t-edit");
      yield* addMessage("m-edit", "t-edit", "first quokka text");
      yield* addMessage("m-edit", "t-edit", "second wombat text");
      assert.strictEqual((yield* search("quokka")).matches.length, 0);
      assert.strictEqual((yield* search("wombat")).matches.length, 1);
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'm-edit'`;
      assert.strictEqual((yield* search("wombat")).matches.length, 0);
      const docs = yield* sql`SELECT 1 FROM message_search_docs WHERE message_id = 'm-edit'`;
      assert.strictEqual(docs.length, 0);
    }),
  );

  it.effect("hides deleted chats and system messages", () =>
    Effect.gen(function* () {
      yield* addThread("t-deleted", { deletedAt: AT });
      yield* addThread("t-live");
      yield* addMessage("m-deleted", "t-deleted", "capybara in a deleted chat");
      yield* addMessage("m-system", "t-live", "capybara from the system", { role: "system" });
      assert.strictEqual((yield* search("capybara")).matches.length, 0);
    }),
  );

  it.effect("gives one result per chat, the best message, with the hit count", () =>
    Effect.gen(function* () {
      yield* addThread("t-one");
      yield* addMessage("m-part", "t-one", "subheron somewhere inside a word");
      yield* addMessage("m-whole", "t-one", "a heron on the lake");
      yield* addMessage("m-old", "t-one", "another heron");
      const { matches } = yield* search("heron");
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0]?.hits, 3);
      assert.strictEqual(matches[0]?.quality, 1);
    }),
  );

  it.effect("needs every word, and two-letter queries alone do not search", () =>
    Effect.gen(function* () {
      yield* addThread("t-words");
      yield* addMessage("m-words", "t-words", "the ocelot went to sleep");
      assert.strictEqual((yield* search("ocelot sleep")).matches.length, 1);
      assert.strictEqual((yield* search("ocelot awake")).matches.length, 0);
      assert.strictEqual((yield* search("to")).matches.length, 0);
    }),
  );

  it.effect("treats FTS syntax in a query as plain text", () =>
    Effect.gen(function* () {
      yield* addThread("t-syntax");
      yield* addMessage("m-syntax", "t-syntax", 'he said "hello" NEAR the door');
      assert.strictEqual((yield* search('"hello" NEAR')).matches.length, 1);
      assert.strictEqual((yield* search('a"b* OR c')).matches.length, 0);
    }),
  );

  it.effect("backfills messages from before the index, and search then sees them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* addThread("t-back");
      yield* sql`DROP TRIGGER message_search_insert`;
      for (let index = 0; index < 450; index += 1) {
        yield* addMessage(`m-back-${index}`, "t-back", `old message ${index} about axolotl`);
      }
      yield* sql`
        CREATE TRIGGER message_search_insert
        AFTER INSERT ON projection_thread_messages
        WHEN new.is_streaming = 0 AND new.role IN ('user', 'assistant')
        BEGIN
          INSERT INTO message_search_docs (message_id) VALUES (new.message_id)
          ON CONFLICT (message_id) DO NOTHING;
          INSERT INTO message_search (rowid, text)
          SELECT doc_id, new.text FROM message_search_docs WHERE message_id = new.message_id;
        END
      `;
      assert.strictEqual(yield* countUnindexedMessages(sql), 450);
      assert.strictEqual((yield* search("axolotl")).matches.length, 0);
      yield* runBackfill;
      assert.strictEqual(yield* countUnindexedMessages(sql), 0);
      const { matches } = yield* search("axolotl");
      assert.strictEqual(matches[0]?.hits, 450);
      // A second pass adds nothing.
      yield* runBackfill;
      assert.strictEqual(yield* countUnindexedMessages(sql), 0);
    }),
  );

  it.effect("survives VACUUM: hits still point at the right messages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* addThread("t-vacuum");
      yield* addMessage("m-gone", "t-vacuum", "filler to delete");
      yield* addMessage("m-kept", "t-vacuum", "the pangolin stays");
      yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'm-gone'`;
      yield* sql`VACUUM`;
      assert.strictEqual(
        (yield* search("pangolin")).matches[0]?.messageId as MessageId as string,
        "m-kept",
      );
    }),
  );

  it.effect("finds inside one chat, in order, with counts and short queries", () =>
    Effect.gen(function* () {
      yield* addThread("t-inner");
      yield* addThread("t-other");
      yield* addMessage("m-1", "t-inner", "Bison and bison", {
        createdAt: "2026-10-30T10:00:01.000Z",
      });
      yield* addMessage("m-2", "t-inner", "nothing here", {
        createdAt: "2026-10-30T10:00:02.000Z",
      });
      yield* addMessage("m-3", "t-inner", "one bison", {
        createdAt: "2026-10-30T10:00:03.000Z",
      });
      yield* addMessage("m-4", "t-other", "bison elsewhere");
      const found = yield* find("t-inner", "bison");
      assert.strictEqual(found.totalMatches, 3);
      assert.deepStrictEqual(
        found.entries.map((entry) => [entry.messageId, entry.count, entry.startIndex]),
        [
          ["m-1", 2, 0],
          ["m-3", 1, 2],
        ],
      );
      assert.strictEqual((yield* find("t-inner", "on")).totalMatches, 4);
      assert.strictEqual((yield* find("t-inner", "and bison")).totalMatches, 1);
      assert.strictEqual((yield* find("t-inner", "zebra")).totalMatches, 0);
    }),
  );

  it.effect("finds in a message still streaming, and not in a link's address", () =>
    Effect.gen(function* () {
      yield* addThread("t-live-find");
      yield* addMessage("m-live", "t-live-find", "live narwhal text", { streaming: true });
      yield* addMessage("m-link", "t-live-find", "[doc](https://example.com/narwhal)");
      const found = yield* find("t-live-find", "narwhal");
      assert.deepStrictEqual(
        found.entries.map((entry) => entry.messageId as string),
        ["m-live"],
      );
    }),
  );
});
