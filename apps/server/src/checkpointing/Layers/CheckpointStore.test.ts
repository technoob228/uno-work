import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vitest";

import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CHECKPOINT_TEMP_SUBDIR, CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import type { VcsError } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { ThreadId } from "@t3tools/contracts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-checkpoint-store-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = CheckpointStoreTestLayer.pipe(
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(
  prefix = "checkpoint-store-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function writeTextFile(
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "CheckpointStore.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

function initRepoWithCommit(
  cwd: string,
): Effect.Effect<
  void,
  VcsError | PlatformError.PlatformError,
  VcsProcess.VcsProcess | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
  });
}

function buildLargeText(lineCount = 5_000): string {
  return Array.from({ length: lineCount }, (_, index) => `line ${String(index).padStart(5, "0")}`)
    .join("\n")
    .concat("\n");
}

it.layer(TestLayer)("CheckpointStoreLive", (it) => {
  describe("captureCheckpoint", () => {
    it.effect("uses scratch space under the daemon temp dir and cleans it up", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-tempdir"),
          0,
        );

        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef });

        const checkpointTempRoot = path.join(config.tempDir, CHECKPOINT_TEMP_SUBDIR);
        expect(checkpointTempRoot.startsWith(config.baseDir)).toBe(true);
        expect(yield* fileSystem.exists(checkpointTempRoot)).toBe(true);
        // The per-capture directory (and its git index) must not survive the capture.
        expect(yield* fileSystem.readDirectory(checkpointTempRoot)).toEqual([]);
        expect(yield* checkpointStore.hasCheckpointRef({ cwd: tmp, checkpointRef })).toBe(true);
      }),
    );
  });

  describe("captureCheckpoint with parents", () => {
    it.effect("writes the snapshot as a child of the given commit with a custom message", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const head = yield* git(tmp, ["rev-parse", "HEAD"]);
        const checkpointRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-parents"),
          0,
        );
        yield* writeTextFile(path.join(tmp, "new.txt"), "new\n");

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef,
          parents: [head],
          message: "uno continue: parents",
        });

        expect(yield* git(tmp, ["rev-parse", `${checkpointRef}^`])).toBe(head);
        expect(yield* git(tmp, ["log", "-1", "--format=%s", checkpointRef])).toBe(
          "uno continue: parents",
        );
        // Plain checkpoints stay parentless root commits.
        const plainRef = checkpointRefForThreadTurn(
          ThreadId.make("thread-checkpoint-store-parents"),
          1,
        );
        yield* checkpointStore.captureCheckpoint({ cwd: tmp, checkpointRef: plainRef });
        expect(yield* git(tmp, ["rev-list", "--count", plainRef])).toBe("1");
        // HEAD and the index are untouched either way.
        expect(yield* git(tmp, ["rev-parse", "HEAD"])).toBe(head);
        expect(yield* git(tmp, ["diff", "--cached", "--name-only"])).toBe("");
      }),
    );
  });

  describe("diffCheckpoints", () => {
    it.effect("returns full oversized checkpoint diffs without truncation", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(path.join(tmp, "README.md"), buildLargeText());
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const diff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(diff).toContain("diff --git");
        expect(diff).not.toContain("[truncated]");
        expect(diff).toContain("+line 04999");
      }),
    );

    it.effect("can hide indentation churn when changes wrap existing lines", () =>
      Effect.gen(function* () {
        const tmp = yield* makeTmpDir();
        yield* initRepoWithCommit(tmp);
        const checkpointStore = yield* CheckpointStore;
        const threadId = ThreadId.make("thread-checkpoint-store-whitespace");
        const fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0);
        const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

        const componentPath = path.join(tmp, "Component.tsx");
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      <h1>Title</h1>",
            "      <p>Body</p>",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: fromCheckpointRef,
        });
        yield* writeTextFile(
          componentPath,
          [
            "export function View() {",
            "  return (",
            "    <section>",
            "      {isReady ? (",
            "        <div>",
            "          <h1>Title</h1>",
            "          <p>Body</p>",
            "        </div>",
            "      ) : null}",
            "    </section>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );
        yield* checkpointStore.captureCheckpoint({
          cwd: tmp,
          checkpointRef: toCheckpointRef,
        });

        const normalDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: false,
        });
        const whitespaceIgnoredDiff = yield* checkpointStore.diffCheckpoints({
          cwd: tmp,
          fromCheckpointRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        });

        expect(normalDiff).toContain("diff --git");
        expect(normalDiff).toContain("-      <h1>Title</h1>");
        expect(normalDiff).toContain("+          <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).toContain("diff --git");
        expect(whitespaceIgnoredDiff).toContain("+      {isReady ? (");
        expect(whitespaceIgnoredDiff).toContain("+        <div>");
        expect(whitespaceIgnoredDiff).not.toContain("-      <h1>Title</h1>");
        expect(whitespaceIgnoredDiff).not.toContain("+          <h1>Title</h1>");
      }),
    );
  });
});
