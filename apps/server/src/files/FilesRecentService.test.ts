/**
 * Files → Recent through the real service: opened files kept in the state
 * file, agents' changes read from `projection_turns` (in-memory SQLite), only
 * files that still exist inside the files root, newest first.
 */
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { FilesService } from "./FilesService.ts";
import { FilesRecentService, makeFilesRecentService } from "./FilesRecentService.ts";
import { statPath } from "./fileManager.ts";
import { FilesError } from "@t3tools/contracts";

const makeFixture = Effect.gen(function* () {
  const sandbox = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-files-recent-")));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => fs.rmSync(sandbox, { recursive: true, force: true })),
  );
  const home = nodePath.join(sandbox, "home");
  const project = nodePath.join(home, "project");
  fs.mkdirSync(nodePath.join(project, "docs"), { recursive: true });
  fs.writeFileSync(nodePath.join(home, "notes.md"), "# notes");
  fs.writeFileSync(nodePath.join(project, "docs", "plan.md"), "# plan");
  fs.writeFileSync(nodePath.join(project, ".env"), "SECRET=1");
  const stateFile = nodePath.join(sandbox, "state", "files-recent.json");

  const filesLayer = Layer.mock(FilesService)({
    rootPath: Effect.succeed(home),
    stat: ({ path }) =>
      Effect.tryPromise({
        try: () => statPath(home, path),
        catch: (cause) => new FilesError({ message: "gone", cause }),
      }),
  });
  const configLayer = Layer.succeed(ServerConfig, { stateDir: sandbox } as never);
  const layer = Layer.effect(
    FilesRecentService,
    makeFilesRecentService({ filePath: stateFile }),
  ).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(filesLayer),
    Layer.provide(configLayer),
  );
  const context = yield* Layer.build(layer);
  const recent = yield* Effect.service(FilesRecentService).pipe(Effect.provide(context));
  const sql = yield* Effect.service(SqlClient.SqlClient).pipe(Effect.provide(context));
  return { home, project, stateFile, recent, sql };
});

it.effect("lists opened files and agents' changes, newest first, only existing ones", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { home, project, stateFile, recent, sql } = yield* makeFixture;

      assert.deepStrictEqual(yield* recent.record({ path: nodePath.join(home, "notes.md") }), {
        recorded: true,
      });
      // Folders, missing files and paths outside the root are not kept.
      assert.deepStrictEqual(yield* recent.record({ path: home }), { recorded: false });
      assert.deepStrictEqual(yield* recent.record({ path: nodePath.join(home, "nope.md") }), {
        recorded: false,
      });
      assert.deepStrictEqual(yield* recent.record({ path: "/etc/hosts" }), { recorded: false });

      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('p1', 'Project', ${project}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at)
        VALUES ('t1', 'p1', 'Write the plan', '{"provider":"codex","model":"gpt-5-codex"}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      const future = new Date(Date.now() + 60_000).toISOString();
      const files = JSON.stringify([
        { path: "docs/plan.md", kind: "modified", additions: 1, deletions: 0 },
        { path: ".env", kind: "modified", additions: 1, deletions: 0 },
        { path: "deleted.md", kind: "modified", additions: 1, deletions: 0 },
      ]);
      yield* sql`
        INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, completed_at, checkpoint_turn_count, checkpoint_files_json)
        VALUES ('t1', 'turn-1', 'completed', ${future}, ${future}, 1, ${files})
      `;

      const { items } = yield* recent.list({});
      assert.deepStrictEqual(
        items.map((item) => [item.entry.path, item.source, item.threadTitle]),
        [
          [nodePath.join(project, "docs", "plan.md"), "agent", "Write the plan"],
          [nodePath.join(home, "notes.md"), "opened", null],
        ],
      );
      // Kept on disk for the next start.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      const stored = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
        items: Array<{ path: string }>;
      };
      assert.deepStrictEqual(
        stored.items.map((item) => item.path),
        [nodePath.join(home, "notes.md")],
      );
    }),
  ),
);
