/**
 * ContinueTransport - git plumbing for "Continue on <machine>".
 *
 * Nothing here talks to a remote in the write direction. The source daemon
 * snapshots the working tree into a WIP commit (parented on HEAD, built with
 * the checkpoint machinery so the user's index and HEAD are never touched)
 * and packs it into a git bundle file. The bundle excludes everything the
 * source already sees on a remote-tracking branch, so it stays small and the
 * target can fill any gap with a plain fetch from its own remotes.
 *
 * On the target the bundle is verified and fetched into a hidden ref, a new
 * worktree is created on a fresh branch at the source's base commit, and the
 * snapshot tree is restored into that worktree — the chat continues with the
 * same uncommitted changes, while the checkout the person already had there
 * stays exactly as it was.
 *
 * Everything here is stateless and per-call. Moving the bundle bytes between
 * machines is `continueTransferStore.ts` plus the client.
 *
 * @module ContinueTransport
 */
import { Context, Effect, Layer } from "effect";

import { CheckpointRef, type VcsError } from "@t3tools/contracts";

import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";

/** Hidden local ref that holds a snapshot commit on either side. */
export const CONTINUE_REFS_PREFIX = "refs/t3/continue";

export function continueLocalRefForTransfer(transferId: string): CheckpointRef {
  return CheckpointRef.make(`${CONTINUE_REFS_PREFIX}/${transferId}`);
}

const NETWORK_TIMEOUT_MS = 10 * 60_000;
const BUNDLE_TIMEOUT_MS = 10 * 60_000;

export interface ContinueRemote {
  readonly name: string;
  readonly url: string;
}

export interface ContinueHead {
  readonly commit: string | null;
  readonly branch: string | null;
}

export interface ContinueStatus extends ContinueHead {
  /** Entries in `git status` (tracked changes plus untracked files, not ignored). */
  readonly changedFiles: number;
}

export interface ContinueBundleCheck {
  /** The repository has every commit the bundle is based on. */
  readonly ok: boolean;
  /** Git's explanation when it does not (missing prerequisite commits, corrupt file). */
  readonly detail: string;
}

export interface ContinueTransportShape {
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, VcsError>;
  /** HEAD plus a count of uncommitted work. Read-only. */
  readonly readStatus: (cwd: string) => Effect.Effect<ContinueStatus, VcsError>;
  /** Fetch URL of `origin`, else of the first remote. Only ever used to clone or fetch. */
  readonly resolveRemote: (cwd: string) => Effect.Effect<ContinueRemote | null, VcsError>;
  readonly readHead: (cwd: string) => Effect.Effect<ContinueHead, VcsError>;
  /** Snapshot the working tree (tracked + untracked, not ignored) into a commit at `ref`; returns the commit oid. */
  readonly captureSnapshot: (input: {
    readonly cwd: string;
    readonly ref: CheckpointRef;
    readonly parents: ReadonlyArray<string>;
    readonly message: string;
  }) => Effect.Effect<string, CheckpointStoreError>;
  /**
   * Writes a bundle with `ref` and every commit behind it that no
   * remote-tracking branch already has (`--not --remotes`). A repository
   * without remotes gets its whole history.
   */
  readonly createBundle: (input: {
    readonly cwd: string;
    readonly ref: CheckpointRef;
    readonly bundlePath: string;
  }) => Effect.Effect<void, VcsError>;
  /** `git bundle verify`: whether this repository has the commits the bundle builds on. */
  readonly verifyBundle: (input: {
    readonly cwd: string;
    readonly bundlePath: string;
  }) => Effect.Effect<ContinueBundleCheck, VcsError>;
  /** `git fetch --all`: pulls in commits the bundle may build on. Reads only. */
  readonly fetchRemotes: (cwd: string) => Effect.Effect<void, VcsError>;
  /** Fetch `ref` out of the bundle into the same local ref; returns the commit oid. */
  readonly fetchBundle: (input: {
    readonly cwd: string;
    readonly bundlePath: string;
    readonly ref: CheckpointRef;
  }) => Effect.Effect<string, VcsError>;
  /** `git init` in an existing, empty folder. */
  readonly initRepository: (cwd: string) => Effect.Effect<void, VcsError>;
  readonly branchExists: (input: {
    readonly cwd: string;
    readonly branch: string;
  }) => Effect.Effect<boolean, VcsError>;
  /** `git worktree add -b <branch> <path> <startPoint>`. */
  readonly addWorktree: (input: {
    readonly cwd: string;
    readonly branch: string;
    readonly path: string;
    readonly startPoint: string;
  }) => Effect.Effect<void, VcsError>;
  /** Put the tree of `ref` into the working tree; HEAD and the current branch stay as they are. */
  readonly restoreTree: (input: {
    readonly cwd: string;
    readonly ref: CheckpointRef;
  }) => Effect.Effect<boolean, CheckpointStoreError>;
  readonly deleteRef: (input: {
    readonly cwd: string;
    readonly ref: CheckpointRef;
  }) => Effect.Effect<void, CheckpointStoreError>;
}

export class ContinueTransport extends Context.Service<ContinueTransport, ContinueTransportShape>()(
  "t3/git/ContinueTransport",
) {}

const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry;
  const checkpointStore = yield* CheckpointStore;

  // The git driver directly, without repository detection: `initRepository`
  // and freshly created worktrees must not hit a cached "not a repository".
  const git = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
  }) => vcsRegistry.get("git").pipe(Effect.flatMap((driver) => driver.execute(input)));

  const gitStdout = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git({ operation, cwd, args, allowNonZeroExit: true }).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
    );

  const isGitRepository: ContinueTransportShape["isGitRepository"] = (cwd) =>
    gitStdout("ContinueTransport.isGitRepository", cwd, [
      "rev-parse",
      "--is-inside-work-tree",
    ]).pipe(
      Effect.map((stdout) => stdout === "true"),
      Effect.catch(() => Effect.succeed(false)),
    );

  const resolveRemote: ContinueTransportShape["resolveRemote"] = Effect.fn("resolveRemote")(
    function* (cwd) {
      const candidates: string[] = ["origin"];
      const listed = yield* gitStdout("ContinueTransport.listRemotes", cwd, ["remote"]);
      for (const name of (listed ?? "").split(/\r?\n/)) {
        const trimmed = name.trim();
        if (trimmed.length > 0 && trimmed !== "origin") {
          candidates.push(trimmed);
        }
      }
      for (const name of candidates) {
        const url = yield* gitStdout("ContinueTransport.remoteGetUrl", cwd, [
          "remote",
          "get-url",
          name,
        ]);
        if (url && url.length > 0) {
          return { name, url };
        }
      }
      return null;
    },
  );

  const readHead: ContinueTransportShape["readHead"] = Effect.fn("readHead")(function* (cwd) {
    const commit = yield* gitStdout("ContinueTransport.readHead.commit", cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      "HEAD^{commit}",
    ]);
    const branch = yield* gitStdout("ContinueTransport.readHead.branch", cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    return {
      commit: commit && commit.length > 0 ? commit : null,
      branch: branch && branch.length > 0 ? branch : null,
    };
  });

  const readStatus: ContinueTransportShape["readStatus"] = Effect.fn("readStatus")(function* (cwd) {
    const head = yield* readHead(cwd);
    // `--untracked-files=all` lists files inside new folders one by one.
    const result = yield* git({
      operation: "ContinueTransport.readStatus",
      cwd,
      args: ["status", "--porcelain", "--untracked-files=all"],
    });
    const changedFiles = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0).length;
    return { ...head, changedFiles };
  });

  const captureSnapshot: ContinueTransportShape["captureSnapshot"] = Effect.fn("captureSnapshot")(
    function* (input) {
      yield* checkpointStore.captureCheckpoint({
        cwd: input.cwd,
        checkpointRef: input.ref,
        parents: input.parents,
        message: input.message,
      });
      const result = yield* git({
        operation: "ContinueTransport.captureSnapshot.resolve",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", `${input.ref}^{commit}`],
      });
      return result.stdout.trim();
    },
  );

  const createBundle: ContinueTransportShape["createBundle"] = (input) =>
    git({
      operation: "ContinueTransport.createBundle",
      cwd: input.cwd,
      args: ["bundle", "create", input.bundlePath, input.ref, "--not", "--remotes"],
      timeoutMs: BUNDLE_TIMEOUT_MS,
    }).pipe(Effect.asVoid);

  const verifyBundle: ContinueTransportShape["verifyBundle"] = (input) =>
    git({
      operation: "ContinueTransport.verifyBundle",
      cwd: input.cwd,
      args: ["bundle", "verify", input.bundlePath],
      allowNonZeroExit: true,
      timeoutMs: BUNDLE_TIMEOUT_MS,
    }).pipe(
      Effect.map((result) => ({
        ok: result.exitCode === 0,
        detail: (result.stderr.trim() || result.stdout.trim()).slice(0, 2_000),
      })),
    );

  const fetchRemotes: ContinueTransportShape["fetchRemotes"] = (cwd) =>
    git({
      operation: "ContinueTransport.fetchRemotes",
      cwd,
      args: ["fetch", "--all", "--no-tags", "--quiet"],
      timeoutMs: NETWORK_TIMEOUT_MS,
    }).pipe(Effect.asVoid);

  const fetchBundle: ContinueTransportShape["fetchBundle"] = Effect.fn("fetchBundle")(
    function* (input) {
      yield* git({
        operation: "ContinueTransport.fetchBundle",
        cwd: input.cwd,
        args: ["fetch", "--no-tags", "--quiet", input.bundlePath, `+${input.ref}:${input.ref}`],
        timeoutMs: BUNDLE_TIMEOUT_MS,
      });
      const result = yield* git({
        operation: "ContinueTransport.fetchBundle.resolve",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", `${input.ref}^{commit}`],
      });
      return result.stdout.trim();
    },
  );

  const initRepository: ContinueTransportShape["initRepository"] = (cwd) =>
    git({ operation: "ContinueTransport.initRepository", cwd, args: ["init", "--quiet"] }).pipe(
      Effect.asVoid,
    );

  const branchExists: ContinueTransportShape["branchExists"] = (input) =>
    git({
      operation: "ContinueTransport.branchExists",
      cwd: input.cwd,
      args: ["show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const addWorktree: ContinueTransportShape["addWorktree"] = (input) =>
    git({
      operation: "ContinueTransport.addWorktree",
      cwd: input.cwd,
      args: ["worktree", "add", "--quiet", "-b", input.branch, input.path, input.startPoint],
      timeoutMs: BUNDLE_TIMEOUT_MS,
    }).pipe(Effect.asVoid);

  const restoreTree: ContinueTransportShape["restoreTree"] = (input) =>
    checkpointStore.restoreCheckpoint({
      cwd: input.cwd,
      checkpointRef: input.ref,
      fallbackToHead: false,
    });

  const deleteRef: ContinueTransportShape["deleteRef"] = (input) =>
    checkpointStore.deleteCheckpointRefs({ cwd: input.cwd, checkpointRefs: [input.ref] });

  return {
    isGitRepository,
    readStatus,
    resolveRemote,
    readHead,
    captureSnapshot,
    createBundle,
    verifyBundle,
    fetchRemotes,
    fetchBundle,
    initRepository,
    branchExists,
    addWorktree,
    restoreTree,
    deleteRef,
  } satisfies ContinueTransportShape;
});

export const ContinueTransportLive = Layer.effect(ContinueTransport, make);
