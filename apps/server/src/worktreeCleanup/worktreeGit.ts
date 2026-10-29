/**
 * Git and file work behind the chat-copy cleanup: read a worktree's state,
 * save its uncommitted work (a snapshot commit under `refs/uno/saved/<chat>`,
 * the same temp-index scheme as checkpoints) and its ignored `.env*` files,
 * remove it, and bring it back with all of that on the next message.
 *
 * Nothing here deletes a branch.
 *
 * @module worktreeCleanup/worktreeGit
 */
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { Effect, Schema } from "effect";

import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";

export type GitExec = GitVcsDriverShape["execute"];

export class WorktreeCleanupError extends Schema.TaggedErrorClass<WorktreeCleanupError>()(
  "WorktreeCleanupError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const SAVED_REF_PREFIX = "refs/uno/saved/";
/** Biggest single `.env*` file that is saved; a bigger one keeps the copy. */
export const ENV_FILE_MAX_BYTES = 1024 * 1024;
export const ENV_FILES_MAX = 50;
/** Uncommitted files bigger than this in total keep the copy: saving them would fill the disk. */
export const SAVED_CHANGES_MAX_BYTES = 200 * 1024 * 1024;
export const SAVED_CHANGES_MAX_FILES = 20_000;
const STATUS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MEASURE_MAX_ENTRIES = 2_000_000;
const MEASURE_TIMEOUT_MS = 30_000;

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Uno Work",
  GIT_AUTHOR_EMAIL: "uno-work@users.noreply.getuno.xyz",
  GIT_COMMITTER_NAME: "Uno Work",
  GIT_COMMITTER_EMAIL: "uno-work@users.noreply.getuno.xyz",
};

/** Thread ids become ref names and folder names: only plain ones. */
export function savedRefFor(threadId: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(threadId)
    ? `${SAVED_REF_PREFIX}${threadId}`
    : null;
}

const fsTry = <A>(detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new WorktreeCleanupError({
        detail: `${detail}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

export const pathExists = (target: string) =>
  Effect.promise(() =>
    lstat(target).then(
      () => true,
      () => false,
    ),
  );

export const realPathOrNull = (target: string) =>
  Effect.promise(() => realpath(target).catch(() => null));

/** `child` is strictly inside `parent` (both already resolved). */
export function isInside(parent: string, child: string): boolean {
  const relative = nodePath.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(relative)
  );
}

interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncate?: boolean;
}

const run = (git: GitExec, cwd: string, args: ReadonlyArray<string>, options: RunOptions = {}) =>
  git({
    operation: "WorktreeCleanup.git",
    cwd,
    args,
    allowNonZeroExit: true,
    env: { LC_ALL: "C", ...options.env },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options.truncate ? { truncateOutputAtMaxBytes: true } : {}),
  }).pipe(
    Effect.mapError(
      (error) =>
        new WorktreeCleanupError({ detail: error.detail.split(/\r?\n/)[0] ?? "git failed" }),
    ),
  );

const runOk = (git: GitExec, cwd: string, args: ReadonlyArray<string>, options?: RunOptions) =>
  run(git, cwd, args, options).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout)
        : Effect.fail(
            new WorktreeCleanupError({
              detail: `git ${args.find((arg) => !arg.startsWith("-")) ?? ""} failed: ${
                result.stderr.trim().split(/\r?\n/)[0]?.slice(0, 500) || `exit ${result.exitCode}`
              }`,
            }),
          ),
    ),
  );

const runOptional = (git: GitExec, cwd: string, args: ReadonlyArray<string>) =>
  run(git, cwd, args).pipe(
    Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)),
  );

export interface WorktreeState {
  /** Checked-out branch; null when HEAD is detached. */
  readonly branch: string | null;
  readonly headSha: string | null;
  /** Git's own lock (`git worktree lock`): never touched. */
  readonly locked: boolean;
  readonly indexLocked: boolean;
  readonly hasSubmodules: boolean;
  /** The repository's shared `.git` folder (real path). */
  readonly commonDir: string;
}

export const readWorktreeState = Effect.fn("WorktreeCleanup.readWorktreeState")(function* (
  git: GitExec,
  cwd: string,
) {
  const gitDir = (yield* runOk(git, cwd, ["rev-parse", "--absolute-git-dir"])).trim();
  const commonDir = yield* repositoryCommonDir(git, cwd);
  const head = yield* run(git, cwd, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = head.exitCode === 0 ? head.stdout.trim() : "";
  return {
    branch: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null,
    headSha: yield* runOptional(git, cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
    locked: yield* pathExists(nodePath.join(gitDir, "locked")),
    indexLocked: yield* pathExists(nodePath.join(gitDir, "index.lock")),
    hasSubmodules: yield* pathExists(nodePath.join(cwd, ".gitmodules")),
    commonDir,
  } satisfies WorktreeState;
});

export const repositoryCommonDir = Effect.fn("WorktreeCleanup.repositoryCommonDir")(function* (
  git: GitExec,
  cwd: string,
) {
  const raw = (yield* runOk(git, cwd, ["rev-parse", "--git-common-dir"])).trim();
  const resolved = nodePath.resolve(cwd, raw);
  return (yield* realPathOrNull(resolved)) ?? resolved;
});

export interface LocalChanges {
  /** Changed, deleted and new files (paths relative to the worktree). */
  readonly paths: ReadonlyArray<string>;
  /** Too many to list: never removed. */
  readonly truncated: boolean;
  /** An untracked folder git didn't look into: another repository inside. */
  readonly nestedRepository: string | null;
}

export const readLocalChanges = Effect.fn("WorktreeCleanup.readLocalChanges")(function* (
  git: GitExec,
  cwd: string,
) {
  const result = yield* run(
    git,
    cwd,
    ["status", "--porcelain=v1", "-z", "--ignore-submodules=none", "--untracked-files=all"],
    { maxOutputBytes: STATUS_MAX_OUTPUT_BYTES, truncate: true, timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    return yield* new WorktreeCleanupError({
      detail: `git status failed: ${result.stderr.trim().split(/\r?\n/)[0] ?? ""}`,
    });
  }
  const records = result.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  let nestedRepository: string | null = null;
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const filePath = record.slice(3);
    if (record.startsWith("??") && filePath.endsWith("/")) nestedRepository ??= filePath;
    paths.push(filePath);
    // Renames and copies carry their source path as the next record.
    if (/^[RC]|^.[RC]/.test(record)) index++;
  }
  return {
    paths,
    truncated: result.stdoutTruncated || paths.length > SAVED_CHANGES_MAX_FILES,
    nestedRepository,
  } satisfies LocalChanges;
});

/** Bytes the uncommitted files take (what a snapshot would copy into the repository). */
export const changedFilesBytes = (cwd: string, paths: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    let total = 0;
    for (const relative of paths) {
      const stat = await lstat(nodePath.join(cwd, relative)).catch(() => null);
      if (stat?.isFile()) total += stat.size;
    }
    return total;
  });

/**
 * The working tree as a git tree (tracked + untracked, minus ignored), built
 * in a throwaway index so the worktree's own index is not touched. Also
 * reports a nested repository / submodule entry, whose files a tree can't hold.
 */
export const writeWorkingTree = Effect.fn("WorktreeCleanup.writeWorkingTree")(function* (
  git: GitExec,
  cwd: string,
  headSha: string,
  tempDir: string,
) {
  yield* fsTry("Couldn't prepare a temp folder", () => mkdir(tempDir, { recursive: true }));
  const indexFile = nodePath.join(tempDir, `worktree-cleanup-index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  return yield* Effect.gen(function* () {
    yield* runOk(git, cwd, ["read-tree", headSha], { env });
    yield* runOk(git, cwd, ["add", "-A", "--", "."], { env, timeoutMs: 300_000 });
    const tree = (yield* runOk(git, cwd, ["write-tree"], { env })).trim();
    if (tree.length === 0) {
      return yield* new WorktreeCleanupError({ detail: "git write-tree returned nothing" });
    }
    const stage = yield* run(git, cwd, ["ls-files", "--stage", "-z"], {
      env,
      maxOutputBytes: 64 * 1024 * 1024,
      truncate: true,
    });
    const gitlink =
      stage.exitCode !== 0 || stage.stdoutTruncated
        ? "(could not check)"
        : (stage.stdout
            .split("\0")
            .find((entry) => entry.startsWith("160000 "))
            ?.split("\t")[1] ?? null);
    return { tree, gitlink };
  }).pipe(Effect.ensuring(Effect.promise(() => rm(indexFile, { force: true }))));
});

/** Commit `tree` on top of HEAD under `ref` and check the ref holds exactly that tree. */
export const saveSnapshot = Effect.fn("WorktreeCleanup.saveSnapshot")(function* (
  git: GitExec,
  cwd: string,
  input: {
    readonly ref: string;
    readonly tree: string;
    readonly headSha: string;
    readonly message: string;
  },
) {
  const commit = (yield* runOk(
    git,
    cwd,
    ["commit-tree", input.tree, "-p", input.headSha, "-m", input.message],
    { env: SNAPSHOT_IDENTITY },
  )).trim();
  yield* runOk(git, cwd, ["update-ref", input.ref, commit]);
  const saved = yield* runOptional(git, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${input.ref}^{tree}`,
  ]);
  if (saved !== input.tree) {
    return yield* new WorktreeCleanupError({ detail: "The saved snapshot doesn't match the copy" });
  }
  return commit;
});

export const deleteRef = (git: GitExec, cwd: string, ref: string) =>
  run(git, cwd, ["update-ref", "-d", ref]).pipe(Effect.asVoid);

export const refExists = (git: GitExec, cwd: string, ref: string) =>
  runOptional(git, cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.map((sha) => sha !== null),
  );

/** Ignored `.env*` files outside node_modules (ignored folders are not looked into). */
export const listIgnoredEnvFiles = Effect.fn("WorktreeCleanup.listIgnoredEnvFiles")(function* (
  git: GitExec,
  cwd: string,
) {
  const result = yield* run(
    git,
    cwd,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { maxOutputBytes: 8 * 1024 * 1024, truncate: true, timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0 || result.stdoutTruncated) {
    return yield* new WorktreeCleanupError({ detail: "Couldn't list the copy's ignored files" });
  }
  return result.stdout
    .split("\0")
    .filter(
      (entry) =>
        entry !== "" &&
        !entry.endsWith("/") &&
        nodePath.posix.basename(entry).startsWith(".env") &&
        !entry.split("/").includes("node_modules"),
    );
});

interface SavedFilesManifest {
  readonly version: 1;
  readonly worktreePath: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly mode?: number;
    readonly link?: string;
  }>;
}

const MANIFEST = "manifest.json";

/**
 * Copy `files` (relative to `cwd`) into `destination`: folder 0700, files
 * 0600, the manifest written last so a half-done save never restores.
 */
export const saveEnvFiles = (cwd: string, files: ReadonlyArray<string>, destination: string) =>
  fsTry("Couldn't save the copy's .env files", async () => {
    if (files.length > ENV_FILES_MAX) throw new Error(`more than ${ENV_FILES_MAX} files`);
    await rm(destination, { recursive: true, force: true });
    await mkdir(nodePath.dirname(destination), { recursive: true, mode: 0o700 });
    await chmod(nodePath.dirname(destination), 0o700);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await chmod(destination, 0o700);
    const entries: Array<SavedFilesManifest["files"][number]> = [];
    for (const relative of files) {
      const source = nodePath.join(cwd, relative);
      if (!isInside(cwd, source)) throw new Error(`${relative} is outside the copy`);
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) {
        entries.push({ path: relative, link: await readlink(source) });
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > ENV_FILE_MAX_BYTES) throw new Error(`${relative} is bigger than 1 MB`);
      const target = nodePath.join(destination, "files", relative);
      await mkdir(nodePath.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      await chmod(target, 0o600);
      entries.push({ path: relative, mode: stat.mode & 0o777 });
    }
    const manifest: SavedFilesManifest = { version: 1, worktreePath: cwd, files: entries };
    await writeFile(nodePath.join(destination, MANIFEST), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    return entries.length;
  });

/** Put saved `.env*` files back; a file already there wins. */
export const restoreEnvFiles = (source: string, cwd: string) =>
  fsTry("Couldn't restore the copy's .env files", async () => {
    const text = await readFile(nodePath.join(source, MANIFEST), "utf8").catch(() => null);
    if (text === null) return 0;
    const manifest = JSON.parse(text) as SavedFilesManifest;
    let restored = 0;
    for (const entry of manifest.files) {
      const target = nodePath.join(cwd, entry.path);
      if (!isInside(cwd, target)) continue;
      if (
        await lstat(target).then(
          () => true,
          () => false,
        )
      )
        continue;
      await mkdir(nodePath.dirname(target), { recursive: true });
      if (entry.link !== undefined) {
        await symlink(entry.link, target);
      } else {
        await copyFile(nodePath.join(source, "files", entry.path), target);
        await chmod(target, entry.mode ?? 0o600);
      }
      restored++;
    }
    return restored;
  });

export const removeSavedFiles = (destination: string) =>
  Effect.promise(() => rm(destination, { recursive: true, force: true }));

/**
 * `git worktree remove` from the main checkout. Without `force` git refuses
 * a copy with changes or untracked files — the last safety net. `force` is
 * only passed after the snapshot was saved and re-checked against the copy.
 */
export const removeWorktree = (
  git: GitExec,
  repoCwd: string,
  worktreePath: string,
  force: boolean,
) =>
  runOk(
    git,
    repoCwd,
    [
      "-c",
      "status.showUntrackedFiles=normal",
      "worktree",
      "remove",
      ...(force ? ["--force"] : []),
      "--",
      worktreePath,
    ],
    { timeoutMs: 300_000 },
  ).pipe(Effect.asVoid);

/**
 * Check the chat's branch out again at `worktreePath`. A branch someone
 * deleted is made again from `startPoint` (the snapshot's base, or HEAD).
 */
export const recreateWorktree = Effect.fn("WorktreeCleanup.recreateWorktree")(function* (
  git: GitExec,
  input: {
    readonly repoCwd: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly startPoint: string | null;
  },
) {
  yield* runOk(git, input.repoCwd, ["worktree", "prune"]);
  const branchExists =
    (yield* runOptional(git, input.repoCwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${input.branch}^{commit}`,
    ])) !== null;
  yield* fsTry("Couldn't create the folder for the chat copy", () =>
    mkdir(nodePath.dirname(input.worktreePath), { recursive: true }),
  );
  yield* runOk(
    git,
    input.repoCwd,
    branchExists
      ? ["worktree", "add", input.worktreePath, input.branch]
      : ["worktree", "add", "-b", input.branch, input.worktreePath, input.startPoint ?? "HEAD"],
    { timeoutMs: 300_000 },
  );
  return { branchCreated: !branchExists };
});

export const snapshotBase = (git: GitExec, cwd: string, ref: string) =>
  runOptional(git, cwd, ["rev-parse", "--verify", "--quiet", `${ref}^1`]);

/**
 * Lay the snapshot's changes over a fresh checkout as uncommitted changes.
 * On the commit it was taken from: exact. On a newer commit: the snapshot's
 * diff is applied on top; a conflict leaves the copy clean and the ref kept.
 */
export const restoreSnapshot = Effect.fn("WorktreeCleanup.restoreSnapshot")(function* (
  git: GitExec,
  cwd: string,
  ref: string,
) {
  const commit = yield* runOptional(git, cwd, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  if (commit === null) return "none" as const;
  const base = yield* snapshotBase(git, cwd, ref);
  const head = yield* runOptional(git, cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (base !== null && base === head) {
    yield* runOk(git, cwd, ["restore", "--source", commit, "--worktree", "--staged", "--", "."], {
      timeoutMs: 300_000,
    });
    yield* runOk(git, cwd, ["reset", "--quiet", "--", "."]);
    return "restored" as const;
  }
  const picked = yield* run(git, cwd, ["cherry-pick", "--no-commit", commit], {
    env: SNAPSHOT_IDENTITY,
    timeoutMs: 300_000,
  });
  if (picked.exitCode === 0) {
    yield* runOk(git, cwd, ["reset", "--quiet", "--", "."]);
    return "restored" as const;
  }
  yield* run(git, cwd, ["cherry-pick", "--abort"]);
  return "conflict" as const;
});

/**
 * Bytes freed by deleting `root`: files with one link, counted by blocks
 * (what the disk gets back). Null when it can't be measured in time.
 */
export const measureFolderBytes = (root: string) =>
  Effect.promise(async () => {
    const deadline = Date.now() + MEASURE_TIMEOUT_MS;
    const pending = [root];
    let entries = 0;
    let bytes = 0;
    while (pending.length > 0) {
      if (Date.now() > deadline) return null;
      const target = pending.pop()!;
      const stat = await lstat(target).catch(() => null);
      if (stat === null || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        const names = await readdir(target).catch(() => [] as string[]);
        entries += names.length;
        if (entries > MEASURE_MAX_ENTRIES) return null;
        for (const name of names) pending.push(nodePath.join(target, name));
      } else if (stat.isFile() && stat.nlink === 1) {
        bytes += stat.blocks > 0 ? stat.blocks * 512 : stat.size;
      }
    }
    return bytes;
  });
