import * as OS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

let counter = 0;

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("appends base64 chunks to an existing file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const chunkA = Buffer.from([0, 1, 2, 255]);
        const chunkB = Buffer.from([42, 0, 7]);
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "data/upload.bin",
          contents: chunkA.toString("base64"),
          encoding: "base64",
        });
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "data/upload.bin",
          contents: chunkB.toString("base64"),
          encoding: "base64",
          mode: "append",
        });

        const saved = yield* fileSystem
          .readFile(path.join(cwd, "data/upload.bin"))
          .pipe(Effect.orDie);
        expect(Buffer.from(saved)).toEqual(Buffer.concat([chunkA, chunkB]));
      }),
    );

    it.effect("append creates the file and parent directories when missing", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "fresh/dir/chunked.txt",
          contents: "first",
          mode: "append",
        });

        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "fresh/dir/chunked.txt"))
          .pipe(Effect.orDie);
        expect(saved).toBe("first");
      }),
    );

    it.effect("expands a home-relative workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = OS.homedir();
        const projectName = `t3code-home-write-${process.pid}-${counter++}`;

        // The second path is where a regression puts the file: a directory
        // literally named "~" next to the process. Clean both so a failing run
        // does not leave junk in the repo.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [path.join(home, projectName), path.join(process.cwd(), "~")],
            (target) =>
              fileSystem.remove(target, { recursive: true }).pipe(Effect.catchCause(() => Effect.void)),
          ).pipe(Effect.asVoid),
        );

        yield* workspaceFileSystem.writeFile({
          cwd: `~/${projectName}`,
          relativePath: "README.md",
          contents: "# Home\n",
        });

        const saved = yield* fileSystem
          .readFileString(path.join(home, projectName, "README.md"))
          .pipe(Effect.orDie);
        expect(saved).toBe("# Home\n");
      }).pipe(Effect.scoped),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("writes binary contents when encoding is base64", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "data/table.xlsx",
          contents: original.toString("base64"),
          encoding: "base64",
        });

        const saved = yield* fileSystem
          .readFile(path.join(cwd, "data/table.xlsx"))
          .pipe(Effect.orDie);
        expect(Buffer.from(saved)).toEqual(original);
      }),
    );
  });
});

describe("WorkspaceFileSystemLive watchFile", () => {
  // Отдельный it.live вне it.layer: watchFile использует Stream.debounce и
  // реальные события fs.watch — под TestClock из it.effect событие не уйдёт
  // никогда, а it.live не наследует слои из обёртки it.layer.
  it.live("emits a changed event when the watched file is rewritten", () =>
    Effect.gen(function* () {
      const workspaceFileSystem = yield* WorkspaceFileSystem;
      const cwd = yield* makeTempDir;
      const path = yield* Path.Path;
      yield* writeTextFile(cwd, "data.csv", "a,b\n1,2\n");
      const absolutePath = path.join(cwd, "data.csv");

      const firstEvent = yield* workspaceFileSystem
        .watchFile({ path: absolutePath })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      // Даём watcher'у успеть зарегистрироваться, затем меняем файл.
      yield* Effect.sleep("150 millis");
      yield* writeTextFile(cwd, "data.csv", "a,b\n1,3\n");

      const events = yield* Fiber.join(firstEvent).pipe(Effect.timeout("5 seconds"), Effect.orDie);
      expect(events).toEqual([{ path: absolutePath, kind: "changed" }]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
