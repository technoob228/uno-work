import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe } from "vitest";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runDoctor } from "./doctor.ts";

const directories: string[] = [];
const newDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), "uno-doctor-"));
  directories.push(directory);
  return join(directory, "state.sqlite");
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

/** A database with a big table written and deleted, as a real one has after compaction. */
const seed = (path: string) =>
  Effect.gen(function* () {
    yield* runMigrations();
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: path })),
    Effect.andThen(
      Effect.sync(() => {
        const db = new DatabaseSync(path);
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("CREATE TABLE filler (body TEXT)");
        const insert = db.prepare("INSERT INTO filler VALUES (?)");
        for (let index = 0; index < 2000; index += 1) insert.run("x".repeat(4000));
        db.exec("DROP TABLE filler");
        db.close();
      }),
    ),
  );

describe("runDoctor", () => {
  it.live("only looks without --fix", () =>
    Effect.gen(function* () {
      const path = newDatabase();
      yield* seed(path);
      const size = statSync(path).size;
      yield* runDoctor(path, { fix: false });
      assert.strictEqual(statSync(path).size, size);
    }),
  );

  it.live("shrinks the file and turns on incremental vacuum with --fix", () =>
    Effect.gen(function* () {
      const path = newDatabase();
      yield* seed(path);
      const size = statSync(path).size;
      yield* runDoctor(path, { fix: true });
      assert.ok(statSync(path).size < size / 2);
      const db = new DatabaseSync(path);
      const mode = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
      db.close();
      assert.strictEqual(mode.auto_vacuum, 2);
    }),
  );

  it.live("refuses while Work has the database open, and changes nothing", () =>
    Effect.gen(function* () {
      const path = newDatabase();
      yield* seed(path);
      const size = statSync(path).size;
      const running = new DatabaseSync(path);
      running.exec("PRAGMA journal_mode = WAL");
      // Idle, as a server between events: nothing but an open file gives it away.
      running.prepare("SELECT COUNT(*) FROM orchestration_events").get();
      const error = yield* runDoctor(path, { fix: true }).pipe(Effect.flip);
      running.close();
      assert.ok(error.message.includes("Close Uno Work"));
      assert.strictEqual(statSync(path).size, size);
    }),
  );

  it.live("says so when there is no database", () =>
    Effect.gen(function* () {
      const error = yield* runDoctor("/nonexistent/state.sqlite", { fix: true }).pipe(Effect.flip);
      assert.ok(error.message.includes("No database"));
    }),
  );
});
