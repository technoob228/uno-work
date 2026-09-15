/**
 * Real-git round trip for the "Continue on <machine>" transport: snapshot on
 * the source, pack a bundle, verify + fetch it on a separate clone, open a new
 * worktree there. A bare repository on disk stands in for GitHub, and every
 * test checks that nothing was pushed to it.
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
  continueLocalRefForTransfer,
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

const lsRemote = (remote: string) =>
  git(remote, ["for-each-ref", "--format=%(refname) %(objectname)"]);

const porcelain = (cwd: string) =>
  git(cwd, ["status", "--porcelain", "--untracked-files=all"]).pipe(
    // `git()` trims stdout, which eats the leading space of the first line;
    // compare entries without their index column.
    Effect.map((status) =>
      status
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => line.trimStart())
        .toSorted(),
    ),
  );

it.layer(TestLayer)("ContinueTransportLive", (it) => {
  describe("round trip through a bundle", () => {
    it.effect(
      "carries unpushed commits, edits, new files and deletions into a new worktree on the target without pushing anything",
      () =>
        Effect.gen(function* () {
          const transport = yield* ContinueTransport;
          const fileSystem = yield* FileSystem.FileSystem;
          const root = yield* makeTmpDir();
          const remote = path.join(root, "remote.git");
          const source = path.join(root, "source");
          const target = path.join(root, "target");
          const bundlePath = path.join(root, "transfer.bundle");

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

          // A local commit that was never pushed, then uncommitted work: an
          // edit, a new file, a deletion and an ignored file that stays behind.
          yield* write(path.join(source, "local.txt"), "local commit\n");
          yield* git(source, ["add", "local.txt"]);
          yield* git(source, ["commit", "-q", "-m", "local only"]);
          yield* write(path.join(source, "edit.txt"), "v2\n");
          yield* write(path.join(source, "src", "new.txt"), "new\n");
          yield* write(path.join(source, "ignored.txt"), "secret\n");
          yield* fileSystem.remove(path.join(source, "gone.txt"));
          const sourceHeadBefore = yield* git(source, ["rev-parse", "HEAD"]);
          const remoteBefore = yield* lsRemote(remote);

          expect(yield* transport.isGitRepository(source)).toBe(true);
          expect(yield* transport.isGitRepository(root)).toBe(false);
          expect(yield* transport.readStatus(source)).toEqual({
            commit: sourceHeadBefore,
            branch: "main",
            changedFiles: 3,
          });
          const resolvedRemote = yield* transport.resolveRemote(source);
          expect(resolvedRemote).toEqual({ name: "origin", url: remote });
          const head = yield* transport.readHead(source);
          expect(head).toEqual({ commit: sourceHeadBefore, branch: "main" });

          const ref = continueLocalRefForTransfer("0f8fad5b-d9cb-469f-a165-70867728950e");
          const commit = yield* transport.captureSnapshot({
            cwd: source,
            ref,
            parents: [head.commit!],
            message: "uno continue: round trip",
          });
          expect(commit).toMatch(/^[0-9a-f]{40}$/);
          // The snapshot sits on top of HEAD and did not touch the source's HEAD or index.
          expect(yield* git(source, ["rev-parse", `${commit}^`])).toBe(sourceHeadBefore);
          expect(yield* git(source, ["rev-parse", "HEAD"])).toBe(sourceHeadBefore);
          expect(yield* git(source, ["diff", "--cached", "--name-only"])).toBe("");
          expect(yield* git(source, ["ls-tree", "-r", "--name-only", commit])).not.toContain(
            "ignored.txt",
          );

          yield* transport.createBundle({ cwd: source, ref, bundlePath });
          yield* transport.deleteRef({ cwd: source, ref });
          // Only what origin does not have: the local commit and the snapshot.
          const listed = yield* git(source, ["bundle", "list-heads", bundlePath]);
          expect(listed).toContain(commit);
          // origin/main is a prerequisite, so the pushed history is not in the bundle.
          const pushedHead = yield* git(source, ["rev-parse", "origin/main"]);
          expect((yield* transport.verifyBundle({ cwd: source, bundlePath })).ok).toBe(true);
          const bundleInfo = yield* git(source, ["bundle", "verify", bundlePath]);
          expect(bundleInfo).toContain(`requires this ref:\n${pushedHead}`);

          // Target: a clean clone on main with its own uncommitted work,
          // which must survive untouched.
          yield* write(path.join(target, "stray.txt"), "mine\n");
          yield* write(path.join(target, "keep.txt"), "target edit\n");
          const targetHeadBefore = yield* git(target, ["rev-parse", "HEAD"]);
          const targetStatusBefore = yield* porcelain(target);

          expect(yield* transport.verifyBundle({ cwd: target, bundlePath })).toMatchObject({
            ok: true,
          });
          const fetched = yield* transport.fetchBundle({ cwd: target, bundlePath, ref });
          expect(fetched).toBe(commit);
          const branch = "uno/continue/thread-rt";
          expect(yield* transport.branchExists({ cwd: target, branch })).toBe(false);
          const worktree = path.join(root, "worktrees", "target", "uno-continue-thread-rt");
          yield* transport.addWorktree({
            cwd: target,
            branch,
            path: worktree,
            startPoint: sourceHeadBefore,
          });
          expect(yield* transport.branchExists({ cwd: target, branch })).toBe(true);
          expect(yield* transport.restoreTree({ cwd: worktree, ref })).toBe(true);
          yield* transport.deleteRef({ cwd: target, ref });

          expect(yield* read(path.join(worktree, "edit.txt"))).toBe("v2\n");
          expect(yield* read(path.join(worktree, "src", "new.txt"))).toBe("new\n");
          expect(yield* read(path.join(worktree, "keep.txt"))).toBe("keep\n");
          expect(yield* read(path.join(worktree, "local.txt"))).toBe("local commit\n");
          expect(yield* exists(path.join(worktree, "gone.txt"))).toBe(false);
          expect(yield* exists(path.join(worktree, "ignored.txt"))).toBe(false);
          // The worktree is on the new branch at the source's HEAD, with the
          // changes uncommitted and unstaged, like on the source.
          expect(yield* git(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe(branch);
          expect(yield* git(worktree, ["rev-parse", "HEAD"])).toBe(sourceHeadBefore);
          expect(yield* git(worktree, ["diff", "--cached", "--name-only"])).toBe("");
          expect(yield* porcelain(worktree)).toEqual(
            ["D gone.txt", "M edit.txt", "?? src/new.txt"].toSorted(),
          );

          // The target's own checkout: same branch, same HEAD, same local work.
          expect(yield* git(target, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
          expect(yield* git(target, ["rev-parse", "HEAD"])).toBe(targetHeadBefore);
          expect(yield* porcelain(target)).toEqual(targetStatusBefore);
          expect(yield* read(path.join(target, "keep.txt"))).toBe("target edit\n");

          // Nothing reached the "GitHub" side.
          expect(yield* lsRemote(remote)).toBe(remoteBefore);
          expect(yield* git(remote, ["for-each-ref", "refs/heads/uno"])).toBe("");
        }),
    );

    it.effect("fills a missing base commit from the target's own remote", () =>
      Effect.gen(function* () {
        const transport = yield* ContinueTransport;
        const root = yield* makeTmpDir();
        const remote = path.join(root, "remote.git");
        const source = path.join(root, "source");
        const target = path.join(root, "target");
        const bundlePath = path.join(root, "transfer.bundle");

        yield* git(root, ["init", "--bare", "--initial-branch=main", remote]);
        yield* git(root, ["clone", "--quiet", remote, source]);
        yield* configureUser(source);
        yield* write(path.join(source, "a.txt"), "1\n");
        yield* git(source, ["add", "."]);
        yield* git(source, ["commit", "-q", "-m", "one"]);
        yield* git(source, ["push", "-q", "-u", "origin", "HEAD:main"]);
        // The target clones now and falls behind the next pushed commit.
        yield* git(root, ["clone", "--quiet", remote, target]);
        yield* write(path.join(source, "a.txt"), "2\n");
        yield* git(source, ["commit", "-q", "-am", "two"]);
        yield* git(source, ["push", "-q", "origin", "HEAD:main"]);
        yield* write(path.join(source, "a.txt"), "3 (uncommitted)\n");

        const head = yield* transport.readHead(source);
        const ref = continueLocalRefForTransfer("1f8fad5b-d9cb-469f-a165-70867728950e");
        const commit = yield* transport.captureSnapshot({
          cwd: source,
          ref,
          parents: [head.commit!],
          message: "uno continue",
        });
        yield* transport.createBundle({ cwd: source, ref, bundlePath });

        const before = yield* transport.verifyBundle({ cwd: target, bundlePath });
        expect(before.ok).toBe(false);
        expect(before.detail.length).toBeGreaterThan(0);
        yield* transport.fetchRemotes(target);
        expect((yield* transport.verifyBundle({ cwd: target, bundlePath })).ok).toBe(true);
        expect(yield* transport.fetchBundle({ cwd: target, bundlePath, ref })).toBe(commit);
      }),
    );

    it.effect("carries the whole history of a repository without remotes into a fresh one", () =>
      Effect.gen(function* () {
        const transport = yield* ContinueTransport;
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* makeTmpDir();
        const source = path.join(root, "source");
        const target = path.join(root, "target");
        const bundlePath = path.join(root, "transfer.bundle");

        yield* fileSystem.makeDirectory(source, { recursive: true });
        yield* git(source, ["init", "-q", "--initial-branch=main"]);
        yield* configureUser(source);
        yield* write(path.join(source, "a.txt"), "committed\n");
        yield* git(source, ["add", "."]);
        yield* git(source, ["commit", "-q", "-m", "one"]);
        yield* write(path.join(source, "b.txt"), "uncommitted\n");
        expect(yield* transport.resolveRemote(source)).toBeNull();

        const head = yield* transport.readHead(source);
        const ref = continueLocalRefForTransfer("2f8fad5b-d9cb-469f-a165-70867728950e");
        const commit = yield* transport.captureSnapshot({
          cwd: source,
          ref,
          parents: [head.commit!],
          message: "uno continue",
        });
        yield* transport.createBundle({ cwd: source, ref, bundlePath });

        yield* fileSystem.makeDirectory(target, { recursive: true });
        yield* transport.initRepository(target);
        expect((yield* transport.verifyBundle({ cwd: target, bundlePath })).ok).toBe(true);
        expect(yield* transport.fetchBundle({ cwd: target, bundlePath, ref })).toBe(commit);
        const worktree = path.join(root, "wt");
        yield* transport.addWorktree({
          cwd: target,
          branch: "uno/continue/x",
          path: worktree,
          startPoint: head.commit!,
        });
        expect(yield* transport.restoreTree({ cwd: worktree, ref })).toBe(true);
        expect(yield* read(path.join(worktree, "a.txt"))).toBe("committed\n");
        expect(yield* read(path.join(worktree, "b.txt"))).toBe("uncommitted\n");
        expect(yield* porcelain(worktree)).toEqual(["?? b.txt"]);
      }),
    );

    it.effect("prefers origin, then the first other remote", () =>
      Effect.gen(function* () {
        const transport = yield* ContinueTransport;
        const root = yield* makeTmpDir();
        yield* git(root, ["init", "-q"]);
        expect(yield* transport.resolveRemote(root)).toBeNull();
        yield* git(root, ["remote", "add", "uno", "https://git.example/uno.git"]);
        expect(yield* transport.resolveRemote(root)).toEqual({
          name: "uno",
          url: "https://git.example/uno.git",
        });
        yield* git(root, ["remote", "add", "origin", "https://github.com/x/y.git"]);
        expect((yield* transport.resolveRemote(root))?.name).toBe("origin");
      }),
    );
  });
});
