/**
 * ContinueTransport - git plumbing for "Continue on <machine>".
 *
 * Git is the transport: the source daemon snapshots the working tree into a
 * WIP commit (parented on HEAD, built with the checkpoint machinery so the
 * user's index and HEAD are never touched), pushes it to a transport branch
 * `uno/continue/<threadId>` on the project remote, and the target daemon
 * fetches that branch and restores its tree into its own working tree
 * without moving its HEAD — so the target keeps its branch and ends up with
 * the same uncommitted changes the source had.
 *
 * Everything here is stateless and per-call; a future continuous mirror can
 * call the same operations on a schedule.
 *
 * @module ContinueTransport
 */
import { Context, Effect, Layer } from "effect";

import { CheckpointRef, type VcsError } from "@t3tools/contracts";

import { CheckpointStore } from "../checkpointing/Services/CheckpointStore.ts";
import type { CheckpointStoreError } from "../checkpointing/Errors.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";

/** Hidden local ref that holds a transport commit on either side. */
export const CONTINUE_REFS_PREFIX = "refs/t3/continue";

export function continueLocalRefForThread(threadId: string): CheckpointRef {
  return CheckpointRef.make(`${CONTINUE_REFS_PREFIX}/${threadId}`);
}

const NETWORK_TIMEOUT_MS = 10 * 60_000;

export interface ContinueRemote {
  readonly name: string;
  readonly url: string;
}

export interface ContinueHead {
  readonly commit: string | null;
  readonly branch: string | null;
}

export interface ContinueTransportShape {
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, VcsError>;
  /** Fetch URL of the named remote, or of `origin` / the first remote when no name is given. */
  readonly resolveRemote: (
    cwd: string,
    remoteName?: string | null,
  ) => Effect.Effect<ContinueRemote | null, VcsError>;
  readonly readHead: (cwd: string) => Effect.Effect<ContinueHead, VcsError>;
  /** Snapshot the working tree (tracked + untracked, not ignored) into a commit at `ref`; returns the commit oid. */
  readonly captureSnapshot: (input: {
    readonly cwd: string;
    readonly ref: CheckpointRef;
    readonly parents: ReadonlyArray<string>;
    readonly message: string;
  }) => Effect.Effect<string, CheckpointStoreError>;
  readonly pushRef: (input: {
    readonly cwd: string;
    readonly remoteName: string;
    readonly localRef: string;
    readonly remoteBranch: string;
  }) => Effect.Effect<void, VcsError>;
  /** Fetch `remoteBranch` from `remoteUrl` into `localRef`; returns the commit oid it points at. */
  readonly fetchBranch: (input: {
    readonly cwd: string;
    readonly remoteUrl: string;
    readonly remoteBranch: string;
    readonly localRef: string;
  }) => Effect.Effect<string, VcsError>;
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

  const git = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
  }) =>
    vcsRegistry
      .resolve({ cwd: input.cwd, requestedKind: "git" })
      .pipe(Effect.flatMap((handle) => handle.driver.execute(input)));

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
    function* (cwd, remoteName) {
      const requested = remoteName?.trim() ?? "";
      const candidates: string[] = [];
      if (requested.length > 0) {
        candidates.push(requested);
      } else {
        candidates.push("origin");
        const listed = yield* gitStdout("ContinueTransport.listRemotes", cwd, ["remote"]);
        for (const name of (listed ?? "").split(/\r?\n/)) {
          const trimmed = name.trim();
          if (trimmed.length > 0 && trimmed !== "origin") {
            candidates.push(trimmed);
          }
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

  const pushRef: ContinueTransportShape["pushRef"] = (input) =>
    git({
      operation: "ContinueTransport.pushRef",
      cwd: input.cwd,
      args: [
        "push",
        "--force",
        "--no-verify",
        input.remoteName,
        `${input.localRef}:refs/heads/${input.remoteBranch}`,
      ],
      timeoutMs: NETWORK_TIMEOUT_MS,
    }).pipe(Effect.asVoid);

  const fetchBranch: ContinueTransportShape["fetchBranch"] = Effect.fn("fetchBranch")(
    function* (input) {
      yield* git({
        operation: "ContinueTransport.fetchBranch",
        cwd: input.cwd,
        args: [
          "fetch",
          "--no-tags",
          "--force",
          input.remoteUrl,
          `+refs/heads/${input.remoteBranch}:${input.localRef}`,
        ],
        timeoutMs: NETWORK_TIMEOUT_MS,
      });
      const result = yield* git({
        operation: "ContinueTransport.fetchBranch.resolve",
        cwd: input.cwd,
        args: ["rev-parse", "--verify", `${input.localRef}^{commit}`],
      });
      return result.stdout.trim();
    },
  );

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
    resolveRemote,
    readHead,
    captureSnapshot,
    pushRef,
    fetchBranch,
    restoreTree,
    deleteRef,
  } satisfies ContinueTransportShape;
});

export const ContinueTransportLive = Layer.effect(ContinueTransport, make);
