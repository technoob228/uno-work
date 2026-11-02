/**
 * Git work behind parallel chats (spec section 2, "Git-приёмы"): snapshot a
 * folder's state into a tree without touching its real index, make a chat's
 * copy, three-way merge the copy into the project folder and move the copy
 * forward. Everything runs on the folder's hidden repository (`.uno-git`,
 * `GIT_DIR` + `GIT_WORK_TREE`); the copy is a linked worktree of it.
 *
 * The project folder is only ever changed with `read-tree -m -u` on a
 * temporary index seeded from the real one: it refuses, instead of
 * overwriting, when a file it would touch changed since the snapshot.
 * The real index and HEAD of the folder are never changed.
 *
 * @module parallelChats/parallelGit
 */
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import nodePath from "node:path";

import { Effect, Schema } from "effect";

import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";

export class ParallelChatsError extends Schema.TaggedErrorClass<ParallelChatsError>()(
  "ParallelChatsError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type GitExec = GitVcsDriverShape["execute"];

/** Where git commands for one side run: the folder (with its hidden repo) or the copy. */
export interface GitAt {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export const UNO_GIT_DIR = ".uno-git";
export const PARALLEL_REF_PREFIX = "refs/uno/parallel/";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Uno Work",
  GIT_AUTHOR_EMAIL: "uno-work@users.noreply.getuno.xyz",
  GIT_COMMITTER_NAME: "Uno Work",
  GIT_COMMITTER_EMAIL: "uno-work@users.noreply.getuno.xyz",
};

/** No hooks (post-checkout runs on worktree add), no gc mid-turn, plain paths. */
const BASE_FLAGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "gc.auto=0",
  "-c",
  "core.quotePath=false",
];

const DEFAULT_TIMEOUT_MS = 60_000;

export function baseRefFor(threadId: string): string {
  return `${PARALLEL_REF_PREFIX}${threadId}/base`;
}

export function conflictRefFor(threadId: string): string {
  return `${PARALLEL_REF_PREFIX}${threadId}/conflict`;
}

/** The project folder: its hidden repository is the git dir, the folder its work tree. */
export function rootAt(root: string): GitAt {
  return {
    cwd: root,
    env: { GIT_DIR: nodePath.join(root, UNO_GIT_DIR), GIT_WORK_TREE: root },
  };
}

/** A copy: a linked worktree, git finds its repository through its `.git` file. */
export function copyAt(copy: string): GitAt {
  return { cwd: copy, env: {} };
}

export type RepoKind = "own-git" | "uno-git" | "none";

export const detectRepoKind = (root: string) =>
  Effect.promise(async () => {
    if (
      await lstat(nodePath.join(root, ".git")).then(
        () => true,
        () => false,
      )
    )
      return "own-git" as const;
    const hidden = await stat(nodePath.join(root, UNO_GIT_DIR)).catch(() => null);
    return hidden?.isDirectory() ? ("uno-git" as const) : ("none" as const);
  });

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const makeParallelGit = (exec: GitExec) => {
  const run = (
    at: GitAt,
    args: ReadonlyArray<string>,
    options: { readonly env?: Record<string, string>; readonly timeoutMs?: number } = {},
  ) =>
    exec({
      operation: "ParallelChats.git",
      cwd: at.cwd,
      args: [...BASE_FLAGS, ...args],
      allowNonZeroExit: true,
      env: { LC_ALL: "C", ...IDENTITY, ...at.env, ...options.env },
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024 * 1024,
    }).pipe(
      Effect.map(
        (result): RunResult => ({
          exitCode: Number(result.exitCode),
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      ),
      Effect.mapError(
        (error) =>
          new ParallelChatsError({
            detail: `git ${args[0] ?? ""}: ${error.message.split(/\r?\n/)[0] ?? "failed"}`,
            cause: error,
          }),
      ),
    );

  const runOk = (
    at: GitAt,
    args: ReadonlyArray<string>,
    options?: { readonly env?: Record<string, string>; readonly timeoutMs?: number },
  ) =>
    run(at, args, options).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              new ParallelChatsError({
                detail: `git ${args[0] ?? ""} failed: ${
                  result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 300) || `exit ${result.exitCode}`
                }`,
              }),
            ),
      ),
    );

  const revParse = (at: GitAt, rev: string) =>
    run(at, ["rev-parse", "--verify", "--quiet", rev]).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
    );

  const treeOf = (at: GitAt, commit: string) =>
    runOk(at, ["rev-parse", `${commit}^{tree}`]).pipe(Effect.map((out) => out.trim()));

  const commitTree = (at: GitAt, tree: string, parents: ReadonlyArray<string>, message: string) =>
    runOk(at, [
      "commit-tree",
      tree,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      message,
    ]).pipe(Effect.map((out) => out.trim()));

  const updateRef = (at: GitAt, ref: string, oid: string) =>
    runOk(at, ["update-ref", ref, oid]).pipe(Effect.asVoid);

  const deleteRef = (at: GitAt, ref: string) =>
    run(at, ["update-ref", "-d", ref]).pipe(Effect.asVoid);

  /** `git rev-parse --git-path index`, made absolute. */
  const indexPath = (at: GitAt) =>
    runOk(at, ["rev-parse", "--git-path", "index"]).pipe(
      Effect.map((out) => nodePath.resolve(at.cwd, out.trim())),
    );

  /**
   * The folder's state as a tree: `add -A` on a temporary index seeded from
   * the real one (0.26 s against 1.2–1.6 s unseeded on 50 000 files). The
   * index file stays for `applyToRoot`; `release` removes it.
   */
  const snapshot = Effect.fn("ParallelChats.snapshot")(function* (at: GitAt, tempDir: string) {
    const real = yield* indexPath(at);
    yield* Effect.promise(() => mkdir(tempDir, { recursive: true }));
    const indexFile = nodePath.join(tempDir, `parallel-${randomUUID()}.index`);
    // Keep the real index's time: git trusts an entry's stat only when the
    // file is older than the index. A copy made now would make a file edited
    // in the same second (and the same size) look unchanged — and an apply
    // would then write over it.
    yield* Effect.promise(async () => {
      const info = await stat(real).catch(() => null);
      if (info === null) return;
      await copyFile(real, indexFile);
      await utimes(indexFile, info.atime, info.mtime);
    }).pipe(Effect.ignore);
    const env = { GIT_INDEX_FILE: indexFile };
    const release = Effect.promise(() => rm(indexFile, { force: true }));
    const tree = yield* runOk(at, ["add", "-A"], { env, timeoutMs: 120_000 }).pipe(
      Effect.andThen(runOk(at, ["write-tree"], { env })),
      Effect.map((out) => out.trim()),
      Effect.tapError(() => release),
    );
    return { tree, indexFile, release };
  });

  /** The tree of a folder's state, no index left behind. */
  const snapshotTree = (at: GitAt, tempDir: string) =>
    snapshot(at, tempDir).pipe(Effect.flatMap((shot) => shot.release.pipe(Effect.as(shot.tree))));

  /** A linked worktree of the folder's repository at `copy`, detached at `commit`. */
  const addCopy = Effect.fn("ParallelChats.addCopy")(function* (
    root: string,
    copy: string,
    commit: string,
  ) {
    const at = rootAt(root);
    yield* Effect.promise(() => mkdir(nodePath.dirname(copy), { recursive: true }));
    // A copy someone removed by hand is still registered: forget it first.
    yield* run(at, ["worktree", "prune"]);
    yield* runOk(at, ["worktree", "add", "-q", "--detach", copy, commit], { timeoutMs: 120_000 });
  });

  const removeCopy = Effect.fn("ParallelChats.removeCopy")(function* (root: string, copy: string) {
    const at = rootAt(root);
    yield* run(at, ["worktree", "remove", "--force", copy]);
    yield* Effect.promise(() => rm(copy, { recursive: true, force: true }));
    yield* run(at, ["worktree", "prune"]);
  });

  /**
   * Three-way merge of two commits that share their parent (the base): no
   * `--merge-base` needed (git 2.38 is enough). `ours` first: its side is
   * between `<<<<<<<` and `=======` in a file with markers.
   */
  const mergeCommits = Effect.fn("ParallelChats.mergeCommits")(function* (
    at: GitAt,
    ours: string,
    theirs: string,
  ) {
    const result = yield* run(at, [
      "merge-tree",
      "--write-tree",
      "-z",
      "--name-only",
      ours,
      theirs,
    ]);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return yield* new ParallelChatsError({
        detail: `git merge-tree failed: ${result.stderr.trim().split(/\r?\n/)[0] ?? ""}`,
      });
    }
    return parseMergeTreeOutput(result.stdout, result.exitCode === 0);
  });

  /**
   * Put `to` into the folder where it holds `from`; the index file is the
   * one `snapshot` made for `from`. False: a file changed meanwhile.
   */
  const applyToRoot = (root: string, from: string, to: string, indexFile: string) =>
    run(rootAt(root), ["read-tree", "-m", "-u", from, to], {
      env: { GIT_INDEX_FILE: indexFile },
    }).pipe(Effect.map((result) => result.exitCode === 0));

  /**
   * Move an idle copy to `tree`: record what it has (a commit on its HEAD),
   * read-tree to the new tree, record that. False: git refused.
   */
  const moveCopy = Effect.fn("ParallelChats.moveCopy")(function* (copy: string, tree: string) {
    const at = copyAt(copy);
    yield* runOk(at, ["add", "-A"], { timeoutMs: 120_000 });
    const current = (yield* runOk(at, ["write-tree"])).trim();
    const head = yield* revParse(at, "HEAD");
    const before = yield* commitTree(at, current, head ? [head] : [], "Uno: this chat's work");
    yield* updateRef(at, "HEAD", before);
    if (current === tree) return true;
    const moved = yield* run(at, ["read-tree", "-m", "-u", before, tree], { timeoutMs: 120_000 });
    if (moved.exitCode !== 0) return false;
    const after = yield* commitTree(at, tree, [before], "Uno: joined the project");
    yield* updateRef(at, "HEAD", after);
    return true;
  });

  /** `git checkout <commit> -- <path>` in a copy (binary-safe: no blob through stdout). */
  const checkoutPath = (copy: string, commit: string, path: string) =>
    runOk(copyAt(copy), ["checkout", commit, "--", path]).pipe(Effect.asVoid);

  /** Ignored `.env*` files of the folder (relative), not inside node_modules. */
  const listIgnoredEnvFiles = (at: GitAt) =>
    run(at, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {
      timeoutMs: 60_000,
    }).pipe(
      Effect.map((result) =>
        result.exitCode !== 0
          ? []
          : result.stdout
              .split("\0")
              .filter(
                (entry) =>
                  entry !== "" &&
                  !entry.endsWith("/") &&
                  nodePath.posix.basename(entry).startsWith(".env") &&
                  !entry.split("/").includes("node_modules"),
              ),
      ),
    );

  /** The message of a commit (what a conflict ref records). */
  const commitMessage = (at: GitAt, commit: string) =>
    runOk(at, ["cat-file", "commit", commit]).pipe(
      Effect.map((out) => {
        const split = out.indexOf("\n\n");
        return split === -1 ? "" : out.slice(split + 2);
      }),
    );

  const firstParent = (at: GitAt, commit: string) => revParse(at, `${commit}^1`);

  return {
    run,
    runOk,
    revParse,
    treeOf,
    commitTree,
    updateRef,
    deleteRef,
    snapshot,
    snapshotTree,
    addCopy,
    removeCopy,
    mergeCommits,
    applyToRoot,
    moveCopy,
    checkoutPath,
    listIgnoredEnvFiles,
    commitMessage,
    firstParent,
  };
};

export type ParallelGit = ReturnType<typeof makeParallelGit>;

export type ConflictKind = "text" | "binary" | "other";

export interface MergeConflict {
  readonly path: string;
  readonly kind: ConflictKind;
}

export type MergeOutcome =
  | { readonly clean: true; readonly tree: string }
  | {
      readonly clean: false;
      readonly tree: string;
      readonly conflicts: ReadonlyArray<MergeConflict>;
    };

/** Conflict types whose file carries markers an agent can edit. */
const TEXT_TYPES = new Set(["Auto-merging", "CONFLICT (contents)", "CONFLICT (add/add)"]);

/**
 * `merge-tree --write-tree -z --name-only` output: the tree, the conflicted
 * paths, an empty entry, then messages as `<n>\0<path>…\0<type>\0<text>\0`.
 */
export function parseMergeTreeOutput(stdout: string, clean: boolean): MergeOutcome {
  const parts = stdout.split("\0");
  const tree = (parts[0] ?? "").trim();
  if (clean) return { clean: true, tree };
  const conflicted: string[] = [];
  let index = 1;
  while (index < parts.length && parts[index] !== "") {
    conflicted.push(parts[index]!);
    index++;
  }
  index++;
  const types = new Map<string, Set<string>>();
  while (index < parts.length) {
    const count = Number.parseInt(parts[index] ?? "", 10);
    if (!Number.isFinite(count) || count <= 0) break;
    const paths = parts.slice(index + 1, index + 1 + count);
    const type = parts[index + 1 + count] ?? "";
    index += count + 3;
    for (const path of paths) {
      const set = types.get(path) ?? new Set<string>();
      set.add(type);
      types.set(path, set);
    }
  }
  const unique = [...new Set(conflicted)];
  return {
    clean: false,
    tree,
    conflicts: unique.map((path) => ({ path, kind: classifyConflict(types.get(path)) })),
  };
}

export function classifyConflict(types: ReadonlySet<string> | undefined): ConflictKind {
  if (types === undefined || types.size === 0) return "other";
  if (types.has("CONFLICT (binary)")) {
    for (const type of types) {
      if (type !== "CONFLICT (binary)" && !TEXT_TYPES.has(type)) return "other";
    }
    return "binary";
  }
  for (const type of types) {
    if (!TEXT_TYPES.has(type)) return "other";
  }
  return "text";
}

const MARKER_LINE = /^(<{7}|>{7})(?: |$)|^={7}$/m;

/** Whether a conflicted file still has marker lines (only files from the conflict list). */
export const fileHasMarkers = (file: string) =>
  Effect.promise(async () => {
    const text = await readFile(file, "utf8").catch(() => null);
    return text !== null && MARKER_LINE.test(text);
  });

/**
 * Number of entries in a git index (its header), without running git: the
 * "more than 100 000 files" check. Null when unreadable.
 */
export const indexEntryCount = (indexFile: string) =>
  Effect.promise(async () => {
    const handle = await open(indexFile, "r").catch(() => null);
    if (handle === null) return null;
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, 12, 0);
      if (bytesRead < 12 || header.toString("latin1", 0, 4) !== "DIRC") return null;
      return header.readUInt32BE(8);
    } finally {
      await handle.close();
    }
  });

/**
 * The project folder a path in a copy belongs to: a copy of a folder synced
 * without git is a linked worktree of `<folder>/.uno-git`, its `.git` file
 * says `gitdir: <folder>/.uno-git/worktrees/<name>`. Null outside such a copy.
 * Keys (`project_keys`, a requested secret) then reach the project from a copy.
 */
export async function projectFolderOfCopy(cwd: string): Promise<string | null> {
  let current = nodePath.resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    const marker = nodePath.join(current, ".git");
    const info = await lstat(marker).catch(() => null);
    if (info !== null) {
      if (!info.isFile()) return null;
      const text = await readFile(marker, "utf8").catch(() => "");
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      if (!match) return null;
      const gitdir = nodePath.resolve(current, match[1]!);
      const parts = gitdir.split(nodePath.sep);
      const at = parts.lastIndexOf("worktrees");
      if (at < 1 || parts[at - 1] !== UNO_GIT_DIR || at !== parts.length - 2) return null;
      return parts.slice(0, at - 1).join(nodePath.sep) || nodePath.sep;
    }
    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
