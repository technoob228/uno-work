/**
 * Real-git round trip for the "Continue on <machine>" transport, with a bare
 * repository on disk standing in for GitHub: snapshot on the source, push,
 * fetch on a separate clone, restore into its working tree.
 */
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vitest";

import type { VcsError } from "@t3tools/contracts";
import { CheckpointStoreLive } from "../checkpointing/Layers/CheckpointStore.ts";
import { ServerConfig } from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  ContinueTransport,
  ContinueTransportLive,
  continueLocalRefForThread,
} from "./continueTransport.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-continue-transport-test-",
});
const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const VcsDriverTestLayer = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessTestLayer));
const CheckpointStoreTestLayer = CheckpointStoreLive.pipe(
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = ContinueTransportLive.pipe(
  Layer.provideMerge(CheckpointStoreTestLayer),
  Layer.provideMerge(VcsProcessTestLayer),
  Layer.provideMerge(VcsDriverTestLayer),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function makeTmpDir(): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix: "continue-transport-test-" });
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, VcsError, VcsProcess.VcsProcess> {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const result = yield* process.run({
      operation: "ContinueTransport.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });
}

const write = (filePath: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const read = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFileString(filePath);
  });

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.exists(filePath);
  });

const configureUser = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
  });

it.layer(TestLayer)("ContinueTransportLive", (it) => {
  describe("round trip through a git remote", () => {
    it.effect(
      "carries tracked edits, new files and deletions to another clone without moving its HEAD",
      () =>
        Effect.gen(function* () {
          const transport = yield* ContinueTransport;
          const root = yield* makeTmpDir();
          const remote = path.join(root, "remote.git");
          const source = path.join(root, "source");
          const target = path.join(root, "target");

          // A bare repo plays GitHub; source and target are two clones of it.
          yield* git(root, ["init", "--bare", "--initial-branch=main", remote]);
          yield* git(root, ["clone", "--quiet", remote, source]);
          yield* configureUser(source);
          yield* write(path.join(source, "keep.txt"), "keep\n");
          yield* write(path.join(source, "edit.txt"), "v1\n");
          yield* write(path.join(source, "gone.txt"), "gone\n");
          yield* write(path.join(source, ".gitignore"), "ignored.txt\n");
          yield* git(source, ["add", "."]);
          yield* git(source, ["commit", "-q", "-m", "initial"]);
          yield* git(source, ["push", "-q", "-u", "origin", "HEAD:main"]);
          yield* git(root, ["clone", "--quiet", remote, target]);
          yield* configureUser(target);

          // Uncommitted work on the source: an edit, a new file, a deletion,
          // an ignored file that must stay behind.
          yield* write(path.join(source, "edit.txt"), "v2\n");
          yield* write(path.join(source, "src", "new.txt"), "new\n");
          yield* write(path.join(source, "ignored.txt"), "secret\n");
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.remove(path.join(source, "gone.txt"));
          const sourceHeadBefore = yield* git(source, ["rev-parse", "HEAD"]);

          expect(yield* transport.isGitRepository(source)).toBe(true);
          expect(yield* transport.isGitRepository(root)).toBe(false);
          const resolvedRemote = yield* transport.resolveRemote(source, null);
          expect(resolvedRemote?.name).toBe("origin");
          expect(resolvedRemote?.url).toBe(remote);
          const head = yield* transport.readHead(source);
          expect(head).toEqual({ commit: sourceHeadBefore, branch: "main" });

          const localRef = continueLocalRefForThread("thread-rt");
          const commit = yield* transport.captureSnapshot({
            cwd: source,
            ref: localRef,
            parents: [head.commit!],
            message: "uno continue: round trip",
          });
          expect(commit).toMatch(/^[0-9a-f]{40}$/);
          // The snapshot sits on top of HEAD and did not touch the source's HEAD or index.
          expect(yield* git(source, ["rev-parse", `${commit}^`])).toBe(sourceHeadBefore);
          expect(yield* git(source, ["rev-parse", "HEAD"])).toBe(sourceHeadBefore);
          expect(yield* git(source, ["diff", "--cached", "--name-only"])).toBe("");
          expect(yield* git(source, ["ls-tree", "--name-only", commit])).not.toContain(
            "ignored.txt",
          );

          yield* transport.pushRef({
            cwd: source,
            remoteName: "origin",
            localRef,
            remoteBranch: "uno/continue/thread-rt",
          });
          expect(yield* git(remote, ["rev-parse", "refs/heads/uno/continue/thread-rt"])).toBe(
            commit,
          );
          yield* transport.deleteRef({ cwd: source, ref: localRef });

          // Target: a clean clone on main, with its own untracked file that
          // the restore must remove (the working tree mirrors the source).
          yield* write(path.join(target, "stray.txt"), "stray\n");
          const targetHeadBefore = yield* git(target, ["rev-parse", "HEAD"]);
          const fetched = yield* transport.fetchBranch({
            cwd: target,
            remoteUrl: remote,
            remoteBranch: "uno/continue/thread-rt",
            localRef,
          });
          expect(fetched).toBe(commit);
          expect(yield* transport.restoreTree({ cwd: target, ref: localRef })).toBe(true);

          expect(yield* read(path.join(target, "edit.txt"))).toBe("v2\n");
          expect(yield* read(path.join(target, "src", "new.txt"))).toBe("new\n");
          expect(yield* read(path.join(target, "keep.txt"))).toBe("keep\n");
          expect(yield* exists(path.join(target, "gone.txt"))).toBe(false);
          expect(yield* exists(path.join(target, "stray.txt"))).toBe(false);
          expect(yield* exists(path.join(target, "ignored.txt"))).toBe(false);
          // Branch and HEAD unchanged; changes are uncommitted and unstaged, like on the source.
          expect(yield* git(target, ["rev-parse", "HEAD"])).toBe(targetHeadBefore);
          expect(yield* git(target, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
          expect(yield* git(target, ["diff", "--cached", "--name-only"])).toBe("");
          // `git()` trims stdout, which eats the leading space of the first
          // porcelain line; compare the entries without their index column.
          const status = yield* git(target, ["status", "--porcelain"]);
          expect(
            status
              .split("\n")
              .map((line) => line.trimStart())
              .toSorted(),
          ).toEqual(["D gone.txt", "M edit.txt", "?? src/"].toSorted());
        }),
    );

    it.effect("reports no remote for a repository without one", () =>
      Effect.gen(function* () {
        const transport = yield* ContinueTransport;
        const root = yield* makeTmpDir();
        yield* git(root, ["init", "-q", "--initial-branch=main"]);
        expect(yield* transport.resolveRemote(root, null)).toBeNull();
        expect(yield* transport.readHead(root)).toEqual({ commit: null, branch: "main" });
      }),
    );

    it.effect("prefers origin, then the first other remote, then the requested name", () =>
      Effect.gen(function* () {
        const transport = yield* ContinueTransport;
        const root = yield* makeTmpDir();
        yield* git(root, ["init", "-q"]);
        yield* git(root, ["remote", "add", "uno", "https://git.example/uno.git"]);
        expect(yield* transport.resolveRemote(root, null)).toEqual({
          name: "uno",
          url: "https://git.example/uno.git",
        });
        yield* git(root, ["remote", "add", "origin", "https://github.com/x/y.git"]);
        expect(yield* transport.resolveRemote(root, null)).toEqual({
          name: "origin",
          url: "https://github.com/x/y.git",
        });
        expect(yield* transport.resolveRemote(root, "uno")).toEqual({
          name: "uno",
          url: "https://git.example/uno.git",
        });
        expect(yield* transport.resolveRemote(root, "missing")).toBeNull();
      }),
    );
  });
});
