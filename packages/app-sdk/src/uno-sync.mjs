// uno-sync — "a project lives on all your computers": one folder kept the same
// on every computer of the person, through their own Uno cloud. Zero
// dependencies, Node >= 18. The Uno Work daemon keeps this file at
// ~/.uno/sdk/js/uno-sync.mjs, next to git-remote-uno.mjs, and runs it for the
// projects the person turned "On all my computers"; `uno project sync|get`
// (uno-cli.mjs) runs it too.
//
// One mechanism for code and documents, no git for the person:
//
//   - A folder without git: Uno keeps a hidden snapshot repository OUTSIDE the
//     folder (~/.uno/sync/<name>.git, the folder is its work tree), commits
//     what changed ("Saved on <computer>") and moves it through the same
//     `uno::<name>` remote git-remote-uno serves. The person's folder gets no
//     .git and no hidden files.
//   - A folder with its own git: the same path on its own repository (remote
//     `uno`, added next to its GitHub one), committed work only — Uno never
//     commits for the person there.
//
// A sync: save local changes → fetch → fast-forward, or merge when both
// computers changed it. Text changes in different places merge; one file
// changed on both sides: the newer version wins and the other one stays in
// the history (decision 08.10) — the conflict is recorded so the person can
// pick "Keep mine" / "Keep theirs" afterwards. The work tree is only ever
// updated with `git read-tree -m -u`, which refuses rather than overwrite a
// file someone edited meanwhile: the sync then simply runs again later.
//
// Never synced: .env* and key files (keys travel through the Uno vault, not
// in files), node_modules, build outputs, anything .gitignore lists; a size
// cap with a clear message.

import { closeSync, openSync, writeSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GIT_ROOT,
  NAME_RE,
  UnoGitError,
  git,
  listProjects,
  openStorage,
  readRemote,
  slugName,
} from "./git-remote-uno.mjs";

/** Snapshot repositories of folders without git: <home>/.uno/sync/<name>.git */
export const SYNC_DIR = path.join(".uno", "sync");
/** One synced project can be at most this big (files that sync). */
export const MAX_PROJECT_BYTES = 1024 * 1024 * 1024;
/** One file can be at most this big. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** A lock older than this belongs to a sync that died. */
export const LOCK_STALE_MS = 10 * 60_000;
/** Conflicts looked at one by one up to this many (more: by the tips' time). */
const MAX_CONFLICT_LOOKUPS = 500;

/**
 * What never travels with a project (git ignore syntax). Keys go through the
 * Uno vault; packages and builds are made again on each computer.
 */
export const DEFAULT_EXCLUDES = [
  "# Kept by Uno: never synced to your other computers.",
  "# Keys travel through the Uno vault, not in files:",
  ".env",
  ".env.*",
  ".envrc",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.ppk",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".ssh/",
  ".aws/",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "# Made again on each computer:",
  "node_modules/",
  ".pnpm-store/",
  "bower_components/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  ".mypy_cache/",
  ".pytest_cache/",
  ".tox/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".output/",
  ".turbo/",
  ".parcel-cache/",
  ".cache/",
  "coverage/",
  "target/",
  ".gradle/",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
  ".git/",
  ".uno-git/",
];

/** Paths a project's own git must not carry for Uno to sync it (keys). */
const KEY_FILE_RE =
  /(^|\/)(\.env(\..*)?|\.envrc|[^/]*\.(pem|key|p12|pfx|jks|keystore|ppk)|id_(rsa|dsa|ecdsa|ed25519)[^/]*|\.netrc|\.npmrc|\.pypirc)$/;

/** True when a path (relative, "/"-separated) is a key file Uno never syncs. */
export function isKeyFile(/** @type {string} */ relative) {
  return KEY_FILE_RE.test(relative) && !/(^|\/)\.env\.(example|sample|template)$/.test(relative);
}

/**
 * @typedef {{ files: string[], kept: Record<string, "mine" | "theirs">, mine: string,
 *   theirs: string, theirsFrom: string | null, at: string }} ConflictRecord
 * @typedef {"synced" | "conflict" | "too-big" | "blocked" | "busy" | "error" | "empty"} SyncState
 * @typedef {{ ok: boolean, name: string, dir: string, mode: "snapshot" | "git", state: SyncState,
 *   pushed: boolean, pulled: boolean, changedFiles: number, head: string | null,
 *   conflict: ConflictRecord | null, message: string }} SyncResult
 * @typedef {{ mode: "snapshot" | "git", remotes?: Record<string, string>, folderName?: string,
 *   createdBy?: string, createdAt?: string }} ProjectMeta
 */

/** A failure the person can act on; `state` says which kind. */
export class SyncError extends UnoGitError {
  /** @param {string} message @param {SyncState} [state] */
  constructor(message, state = "error") {
    super(message);
    this.state = state;
  }
}

const metaKey = (/** @type {string} */ name) => `${GIT_ROOT}${name}/meta.json`;

/** The project's meta in the cloud (how it syncs), or null (older `uno project sync`). */
export async function readMeta(
  /** @type {import("./git-remote-uno.mjs").Storage} */ storage,
  /** @type {string} */ name,
) {
  const bytes = await storage.read(metaKey(name)).catch(() => null);
  if (!bytes) return null;
  try {
    const raw = JSON.parse(bytes.toString("utf8"));
    if (raw?.mode !== "snapshot" && raw?.mode !== "git") return null;
    /** @type {ProjectMeta} */
    const meta = { mode: raw.mode };
    if (raw.remotes && typeof raw.remotes === "object") {
      meta.remotes = Object.fromEntries(
        Object.entries(raw.remotes).flatMap(([remote, url]) => {
          const safe = safeRemoteUrl(url);
          return /^[A-Za-z0-9._-]{1,64}$/.test(remote) && remote !== "uno" && safe
            ? [[remote, safe]]
            : [];
        }),
      );
    }
    if (typeof raw.folderName === "string") meta.folderName = raw.folderName.slice(0, 200);
    return meta;
  } catch {
    return null;
  }
}

/** @param {import("./git-remote-uno.mjs").Storage} storage @param {string} name @param {ProjectMeta} meta */
export async function writeMeta(storage, name, meta) {
  await storage.write(
    metaKey(name),
    Buffer.from(`${JSON.stringify({ ...meta, createdAt: new Date().toISOString() }, null, 2)}\n`),
  );
}

/**
 * A remote URL fit to travel: https/ssh/git only, no user:password inside
 * (a token pasted into a URL must not reach the other computers).
 */
export function safeRemoteUrl(/** @type {unknown} */ raw) {
  if (typeof raw !== "string" || raw.length > 500 || /\s/.test(raw)) return null;
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (!["https:", "ssh:", "git:"].includes(url.protocol)) return null;
    if (url.password || (url.username && url.protocol === "https:")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ── git, with our helper always findable ────────────────────────────────

const helperModule = () => fileURLToPath(new URL("./git-remote-uno.mjs", import.meta.url));
const shQuote = (/** @type {string} */ value) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * `<home>/.uno/sync/bin/git-remote-uno`: runs the helper next to this file
 * with the very runtime running us (the daemon's Node, or Electron as Node on
 * a laptop with no `node` on PATH). Returns its folder, for PATH.
 */
export async function ensureHelperLauncher(/** @type {string} */ home) {
  const dir = path.join(home, SYNC_DIR, "bin");
  const file = path.join(dir, "git-remote-uno");
  const want = `#!/bin/sh\n# Kept by Uno Work (uno-sync.mjs).\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(process.execPath)} ${shQuote(helperModule())} "$@"\n`;
  const have = await fsp.readFile(file, "utf8").catch(() => null);
  if (have !== want) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, want, { mode: 0o755 });
    await fsp.rename(tmp, file);
  }
  return dir;
}

/**
 * @typedef {{ home: string, env: NodeJS.ProcessEnv, hostname?: string,
 *   now?: () => number, storage?: import("./git-remote-uno.mjs").Storage }} Ctx
 */

/** The environment our git runs with. */
async function gitEnv(/** @type {Ctx} */ ctx, /** @type {Record<string, string>} */ extra = {}) {
  const bin = await ensureHelperLauncher(ctx.home);
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...ctx.env,
    HOME: ctx.home,
    PATH: [bin, ...(ctx.env.PATH ?? "").split(path.delimiter).filter(Boolean)].join(path.delimiter),
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  };
  delete env.GIT_INDEX_FILE;
  if (!extra.GIT_DIR) {
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
  }
  return env;
}

/**
 * @param {string[]} args
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, input?: string }} at
 * @param {string} what what failed, for the message
 */
async function gitOk(args, at, what) {
  const result = await git(args, at);
  if (result.code !== 0) {
    const reason =
      result.stderr
        .trim()
        .split("\n")
        .findLast((line) => line.trim()) ?? "";
    throw new SyncError(`${what}: ${reason.replace(/^(fatal|error|uno): /, "")}`);
  }
  return result.stdout;
}

const revOf = async (/** @type {string} */ ref, /** @type {any} */ at) => {
  const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], at);
  return result.code === 0 ? result.stdout.trim() : null;
};

const isAncestor = async (
  /** @type {string} */ a,
  /** @type {string} */ b,
  /** @type {any} */ at,
) => (await git(["merge-base", "--is-ancestor", a, b], at)).code === 0;

// ── A lock per repository ───────────────────────────────────────────────

/** Take `<gitDir>/uno-sync.lock`; null when another live sync holds it. */
async function lock(/** @type {string} */ gitDir) {
  const file = path.join(gitDir, "uno-sync.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      return () => fsp.rm(file, { force: true });
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code !== "EEXIST") throw error;
      const text = await fsp.readFile(file, "utf8").catch(() => "");
      const stats = await fsp.stat(file).catch(() => null);
      const pid = Number(text.split(" ")[0]);
      const alive = Number.isSafeInteger(pid) && pid > 0 && processAlive(pid);
      if (alive && stats && Date.now() - stats.mtimeMs < LOCK_STALE_MS) return null;
      await fsp.rm(file, { force: true });
    }
  }
  return null;
}

function processAlive(/** @type {number} */ pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {{ code?: string }} */ (error).code === "EPERM";
  }
}

// ── Where a project's repository is ─────────────────────────────────────

/** The snapshot repository of a folder without git. */
export function snapshotGitDir(/** @type {string} */ home, /** @type {string} */ name) {
  return path.join(home, SYNC_DIR, `${name}.git`);
}

/** The folder's own git (its top, its git dir), or null when it has none. */
export async function ownGit(/** @type {string} */ dir, /** @type {NodeJS.ProcessEnv} */ env) {
  const stat = await fsp.stat(path.join(dir, ".git")).catch(() => null);
  if (!stat) return null;
  const at = { env, cwd: dir };
  const top = await git(["rev-parse", "--show-toplevel"], at);
  const gitDir = await git(["rev-parse", "--absolute-git-dir"], at);
  if (top.code !== 0 || gitDir.code !== 0) return null;
  return { top: top.stdout.trim(), gitDir: gitDir.stdout.trim() };
}

/** The name a folder syncs as when the person doesn't pick one. */
export function defaultName(/** @type {string} */ dir) {
  return slugName(path.basename(dir)) ?? "project";
}

// ── Sizes ───────────────────────────────────────────────────────────────

const human = (/** @type {number} */ bytes) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${Math.round(bytes / 1024 ** 2)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Every file that would sync (tracked or new, minus excludes), with sizes.
 * Throws "too-big" before anything is hashed into the repository.
 * @param {{ env: NodeJS.ProcessEnv, cwd: string }} at
 * @param {string} workTree
 */
async function checkSize(at, workTree) {
  const listed = await gitOk(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    at,
    "Couldn't list the project's files",
  );
  let total = 0;
  /** @type {{ file: string, size: number } | null} */
  let biggest = null;
  for (const file of new Set(listed.split("\0").filter(Boolean))) {
    const stats = await fsp.lstat(path.join(workTree, file)).catch(() => null);
    if (!stats?.isFile()) continue;
    total += stats.size;
    if (!biggest || stats.size > biggest.size) biggest = { file, size: stats.size };
  }
  const advice =
    "Keep big files (videos, datasets, archives) in Uno Drive, or list them in .gitignore.";
  if (biggest && biggest.size > MAX_FILE_BYTES) {
    throw new SyncError(
      `${biggest.file} is ${human(biggest.size)}; one file can be at most ${human(MAX_FILE_BYTES)} to sync. ${advice}`,
      "too-big",
    );
  }
  if (total > MAX_PROJECT_BYTES) {
    throw new SyncError(
      `This project is ${human(total)}; a project syncs up to ${human(MAX_PROJECT_BYTES)}. The biggest file: ${biggest?.file} (${human(biggest?.size ?? 0)}). ${advice}`,
      "too-big",
    );
  }
  return total;
}

// ── The merge: newer version of a file wins, both stay in history ───────

/** Seconds since 1970 of the newest commit on `tip` touching `file`. */
async function commitTimeOf(
  /** @type {string} */ tip,
  /** @type {string | null} */ file,
  /** @type {any} */ at,
) {
  const args = ["log", "-1", "--format=%ct", tip, ...(file ? ["--", file] : [])];
  const out = (await git(args, at)).stdout.trim();
  return Number(out) || 0;
}

/** `git ls-tree` entry of one path at a commit, or null when it isn't there. */
async function entryAt(
  /** @type {string} */ commit,
  /** @type {string} */ file,
  /** @type {any} */ at,
) {
  const out = (await git(["ls-tree", "-z", commit, "--", file], at)).stdout;
  const match = /^(\d+) (\w+) ([0-9a-f]+)\t/.exec(out);
  if (!match || match[2] === "tree") return null;
  return { mode: /** @type {string} */ (match[1]), oid: /** @type {string} */ (match[3]) };
}

/**
 * A tree: `base` with the given paths set to (or removed from) these entries,
 * built in a scratch index — the person's index and files are not touched.
 * @param {string} base a tree or commit
 * @param {Map<string, { mode: string, oid: string } | null>} changes
 * @param {{ env: NodeJS.ProcessEnv, cwd: string }} at
 * @param {string} gitDir
 */
async function treeWith(base, changes, at, gitDir) {
  const index = path.join(gitDir, "uno", `index-${process.pid}-${Date.now()}`);
  await fsp.mkdir(path.dirname(index), { recursive: true });
  const scratch = { ...at, env: { ...at.env, GIT_INDEX_FILE: index } };
  try {
    await gitOk(["read-tree", base], scratch, "Couldn't prepare the merge");
    const input = [...changes]
      .map(([file, entry]) =>
        entry ? `${entry.mode} ${entry.oid}\t${file}` : `0 ${"0".repeat(40)}\t${file}`,
      )
      .join("\n");
    if (input) {
      await gitOk(
        ["update-index", "--index-info"],
        { ...scratch, input: `${input}\n` },
        "Couldn't prepare the merge",
      );
    }
    return (await gitOk(["write-tree"], scratch, "Couldn't prepare the merge")).trim();
  } finally {
    await fsp.rm(index, { force: true });
  }
}

/**
 * Merge `theirs` into `mine` without touching the work tree. Conflicted
 * files: the newer version wins (`localTime` says when a file of mine last
 * changed). Returns the merge commit and what was decided.
 * @param {{ mine: string, theirs: string, at: any, gitDir: string, message: string,
 *   localTime: (file: string) => Promise<number> }} input
 */
async function mergeNewerWins(input) {
  const { mine, theirs, at } = input;
  const related = (await git(["merge-base", mine, theirs], at)).code === 0;
  const merged = await git(
    [
      "merge-tree",
      "--write-tree",
      "-z",
      "--name-only",
      "--no-messages",
      ...(related ? [] : ["--allow-unrelated-histories"]),
      mine,
      theirs,
    ],
    at,
  );
  if (merged.code !== 0 && merged.code !== 1) {
    const why = merged.stderr.trim().split("\n").at(-1) ?? "";
    throw new SyncError(
      /usage|unknown option|write-tree/i.test(why)
        ? "This computer's git is too old to sync projects (needs git 2.38 or newer)."
        : `Couldn't merge the changes from your other computer: ${why}`,
    );
  }
  const [tree = "", ...files] = merged.stdout.split("\0").filter(Boolean);
  /** @type {Record<string, "mine" | "theirs">} */
  const kept = {};
  if (merged.code === 0) return { tree, conflicts: kept };
  const many = files.length > MAX_CONFLICT_LOOKUPS;
  const mineTip = many ? await commitTimeOf(mine, null, at) : 0;
  const theirsTip = many ? await commitTimeOf(theirs, null, at) : 0;
  /** @type {Map<string, { mode: string, oid: string } | null>} */
  const changes = new Map();
  for (const file of files) {
    const mineAt = many ? mineTip : await input.localTime(file);
    const theirsAt = many ? theirsTip : await commitTimeOf(theirs, file, at);
    const winner = mineAt >= theirsAt ? "mine" : "theirs";
    kept[file] = winner;
    changes.set(file, await entryAt(winner === "mine" ? mine : theirs, file, at));
  }
  return { tree: await treeWith(tree, changes, at, input.gitDir), conflicts: kept };
}

/**
 * Move the work tree and `ref` from `from` to `to`. read-tree -m -u refuses
 * (instead of overwriting) when a file changed since `from`.
 * @returns {Promise<boolean>} false: the folder changed meanwhile, try later
 */
async function moveTo(
  /** @type {string} */ ref,
  /** @type {string | null} */ from,
  /** @type {string} */ to,
  /** @type {any} */ at,
) {
  const updated = from
    ? await git(["read-tree", "-m", "-u", from, to], at)
    : await git(["read-tree", "-m", "-u", to], at);
  if (updated.code !== 0) return false;
  await gitOk(
    ["update-ref", ref, to, ...(from ? [from] : [])],
    at,
    "Couldn't record the new version",
  );
  return true;
}

// ── Conflict record (for "Keep mine" / "Keep theirs") ───────────────────

const conflictFile = (/** @type {string} */ gitDir) => path.join(gitDir, "uno-conflict.json");

/** @returns {Promise<ConflictRecord | null>} */
export async function readConflict(/** @type {string} */ gitDir) {
  try {
    const raw = JSON.parse(await fsp.readFile(conflictFile(gitDir), "utf8"));
    return Array.isArray(raw?.files) && typeof raw.mine === "string" ? raw : null;
  } catch {
    return null;
  }
}

/** @param {string} gitDir @param {ConflictRecord | null} record */
async function writeConflict(gitDir, record) {
  if (!record) {
    await fsp.rm(conflictFile(gitDir), { force: true });
    return;
  }
  await fsp.writeFile(conflictFile(gitDir), `${JSON.stringify(record, null, 2)}\n`);
}

// ── One sync ────────────────────────────────────────────────────────────

/**
 * @typedef {{ dir: string, name?: string | null, adopt?: boolean, reason?: string }} SyncInput
 *   adopt: the folder may join a cloud project with a different history (Get it here).
 */

/**
 * Sync one folder now. Never throws for something the person can act on:
 * the result's `state` and `message` say it.
 * @param {SyncInput} input
 * @param {Ctx} ctx
 * @returns {Promise<SyncResult>}
 */
export async function syncProject(input, ctx) {
  const dir = path.resolve(input.dir);
  const env = await gitEnv(ctx);
  const own = await ownGit(dir, env);
  const mode = own ? "git" : "snapshot";
  /** @type {SyncResult} */
  const result = {
    ok: false,
    name: input.name ?? "",
    dir,
    mode,
    state: "error",
    pushed: false,
    pulled: false,
    changedFiles: 0,
    head: null,
    conflict: null,
    message: "",
  };
  try {
    const stats = await fsp.stat(dir).catch(() => null);
    if (!stats?.isDirectory()) throw new SyncError(`${dir} isn't a folder on this computer.`);
    const name = input.name ?? (own ? await remoteName(own.top, env) : null) ?? defaultName(dir);
    if (!NAME_RE.test(name)) throw new SyncError(`"${name}" can't be a project name.`);
    result.name = name;
    if (own) await syncGit({ ...input, dir: own.top, name }, own.gitDir, ctx, result);
    else await syncSnapshot({ ...input, dir, name }, ctx, result);
  } catch (error) {
    if (!(error instanceof UnoGitError)) throw error;
    result.ok = false;
    result.state = error instanceof SyncError ? error.state : "error";
    result.message = error.message;
  }
  return result;
}

/** The `uno::` name of a repository's `uno` remote, if it has one. */
async function remoteName(/** @type {string} */ top, /** @type {NodeJS.ProcessEnv} */ env) {
  const url = await git(["remote", "get-url", "uno"], { env, cwd: top });
  if (url.code !== 0) return null;
  const value = url.stdout.trim();
  if (!value.startsWith("uno::")) {
    throw new SyncError(`The git remote "uno" here points to ${value}, not to your Uno cloud.`);
  }
  return value.slice("uno::".length);
}

const storageOf = (/** @type {Ctx} */ ctx) =>
  ctx.storage ?? openStorage({ home: ctx.home, env: ctx.env });

/**
 * A folder without git: commit what changed into the snapshot repository,
 * then exchange with the cloud.
 * @param {Required<Pick<SyncInput, "dir">> & SyncInput & { name: string }} input
 * @param {Ctx} ctx
 * @param {SyncResult} result
 */
async function syncSnapshot(input, ctx, result) {
  const gitDir = snapshotGitDir(ctx.home, input.name);
  const host = ctx.hostname ?? os.hostname();
  const fresh = !(await fsp.stat(gitDir).catch(() => null));
  if (fresh) await initSnapshot(gitDir, input.name, ctx);
  await linkFolder(gitDir, input.dir, input.adopt === true, ctx);
  const env = await gitEnv(ctx, { GIT_DIR: gitDir, GIT_WORK_TREE: input.dir });
  const at = { env, cwd: input.dir };
  const release = await lock(gitDir);
  if (!release) {
    result.state = "busy";
    result.message = "Another sync of this project is running.";
    return;
  }
  try {
    await checkSize(at, input.dir);
    await gitOk(["add", "-A"], at, "Couldn't save the project's changes");
    const before = await revOf("HEAD", at);
    if ((await git(["diff", "--cached", "--quiet"], at)).code !== 0) {
      result.changedFiles = (await gitOk(["diff", "--cached", "--name-only", "-z"], at, "git diff"))
        .split("\0")
        .filter(Boolean).length;
      await gitOk(
        ["commit", "-q", "--no-verify", "-m", `Saved on ${host}`],
        at,
        "Couldn't save the project's changes",
      );
    }
    const storage = storageOf(ctx);
    const meta = await readMeta(storage, input.name);
    if (meta?.mode === "git") {
      throw new SyncError(
        `"${input.name}" in your Uno cloud is a git project; this folder has no git. Turn sync off and on again to save it under another name.`,
        "blocked",
      );
    }
    const local = await revOf("refs/heads/main", at);
    if (!local && !before) {
      const remote = await readRemote(storage, input.name);
      if (Object.keys(remote.refs).length === 0) {
        result.ok = true;
        result.state = "empty";
        result.message = "Nothing to sync yet: the folder is empty.";
        return;
      }
    }
    await exchange({
      at,
      gitDir,
      branch: "main",
      input,
      result,
      storage,
      meta,
      writeMetaAs: { mode: "snapshot", folderName: path.basename(input.dir), createdBy: host },
      localTime: async (file) => {
        const stats = await fsp.lstat(path.join(input.dir, file)).catch(() => null);
        return stats ? Math.floor(stats.mtimeMs / 1000) : commitTimeOf("HEAD", file, at);
      },
      mergeMessage: (from) => `Synced with ${from ?? "your other computer"}`,
      refuseUnrelated: input.adopt !== true,
    });
  } finally {
    await release();
  }
}

/** A new snapshot repository: bare storage, the folder as its work tree. */
async function initSnapshot(
  /** @type {string} */ gitDir,
  /** @type {string} */ name,
  /** @type {Ctx} */ ctx,
) {
  await fsp.mkdir(path.dirname(gitDir), { recursive: true });
  const tmp = `${gitDir}.${process.pid}.tmp`;
  await fsp.rm(tmp, { recursive: true, force: true });
  const env = await gitEnv(ctx);
  const at = { env, cwd: path.dirname(gitDir) };
  await gitOk(["init", "-q", "--bare", tmp], at, "Couldn't set up syncing");
  const config = (/** @type {string[]} */ args) =>
    gitOk(["--git-dir", tmp, "config", ...args], at, "Couldn't set up syncing");
  await config(["core.bare", "false"]);
  await config(["core.autocrlf", "false"]);
  await config(["core.quotePath", "false"]);
  await config(["user.name", "Uno"]);
  await config(["user.email", "sync@uno4.me"]);
  await config(["commit.gpgSign", "false"]);
  await config(["remote.uno.url", `uno::${name}`]);
  await config(["remote.uno.fetch", "+refs/heads/*:refs/remotes/uno/*"]);
  await gitOk(["--git-dir", tmp, "symbolic-ref", "HEAD", "refs/heads/main"], at, "git");
  await fsp.mkdir(path.join(tmp, "info"), { recursive: true });
  await fsp.writeFile(path.join(tmp, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`);
  await fsp.rename(tmp, gitDir).catch(async (error) => {
    await fsp.rm(tmp, { recursive: true, force: true });
    // Another sync made it first: theirs is as good.
    if (!(await fsp.stat(gitDir).catch(() => null))) throw error;
  });
}

/**
 * The snapshot repository belongs to one folder. A second folder may take
 * it only on purpose (Get it here into a new place, a moved folder); else
 * it's refused — two folders committing into one history would undo each
 * other. Taking it over starts the new folder as new: its files are merged
 * with the project's, never read as "everything was deleted". The old
 * folder's last version stays under refs/uno/previous/.
 * @param {string} gitDir @param {string} dir @param {boolean} adopt @param {Ctx} ctx
 */
async function linkFolder(gitDir, dir, adopt, ctx) {
  const file = path.join(gitDir, "uno-folder");
  const linked = (await fsp.readFile(file, "utf8").catch(() => "")).trim();
  if (linked === dir) return;
  if (linked && !adopt && (await fsp.stat(linked).catch(() => null))) {
    throw new SyncError(
      `Another folder on this computer (${linked}) already syncs as this project.`,
      "blocked",
    );
  }
  if (linked) {
    const at = { env: await gitEnv(ctx, { GIT_DIR: gitDir, GIT_WORK_TREE: dir }), cwd: dir };
    const old = await revOf("refs/heads/main", at);
    if (old) {
      const keep = `refs/uno/previous/${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await gitOk(["update-ref", keep, old], at, "Couldn't set up syncing");
      await gitOk(["update-ref", "-d", "refs/heads/main", old], at, "Couldn't set up syncing");
    }
    await fsp.rm(path.join(gitDir, "index"), { force: true });
  }
  await fsp.writeFile(file, `${dir}\n`);
}

/**
 * A folder with its own git: committed work of the current branch only.
 * @param {SyncInput & { dir: string, name: string }} input
 * @param {string} gitDir
 * @param {Ctx} ctx
 * @param {SyncResult} result
 */
async function syncGit(input, gitDir, ctx, result) {
  const env = await gitEnv(ctx);
  const at = { env, cwd: input.dir };
  const release = await lock(gitDir);
  if (!release) {
    result.state = "busy";
    result.message = "Another sync of this project is running.";
    return;
  }
  try {
    const branch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], at)).stdout.trim();
    if (!branch)
      throw new SyncError("Switch this project to a branch first (git switch main).", "blocked");
    const head = await revOf("HEAD", at);
    const tracked = head
      ? (await gitOk(["ls-tree", "-r", "-z", "--name-only", "HEAD"], at, "git ls-tree"))
          .split("\0")
          .filter(Boolean)
      : [];
    const keys = tracked.filter(isKeyFile);
    if (keys.length > 0) {
      throw new SyncError(
        `This project's git keeps ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}. Keys never travel in files: take them out of git (git rm --cached <file>, then commit) and Uno will sync the project; the keys go with it through Uno.`,
        "blocked",
      );
    }
    const hasRemote = (await git(["remote", "get-url", "uno"], at)).code === 0;
    const already = hasRemote ? await remoteName(input.dir, env) : null;
    if (already && already !== input.name) {
      throw new SyncError(`This project already syncs as "${already}".`, "blocked");
    }
    if (!(await git(["config", "user.email"], at)).stdout.trim()) {
      Object.assign(env, {
        GIT_AUTHOR_NAME: "Uno",
        GIT_AUTHOR_EMAIL: "sync@uno4.me",
        GIT_COMMITTER_NAME: "Uno",
        GIT_COMMITTER_EMAIL: "sync@uno4.me",
      });
    }
    const storage = storageOf(ctx);
    const meta = await readMeta(storage, input.name);
    if (meta?.mode === "snapshot") {
      throw new SyncError(
        `"${input.name}" in your Uno cloud is a folder without git; this one has git. Turn sync off and on again to save it under another name.`,
        "blocked",
      );
    }
    if (!head) {
      const remote = await readRemote(storage, input.name);
      if (Object.keys(remote.refs).length === 0) {
        result.ok = true;
        result.state = "empty";
        result.message =
          'Nothing to sync yet: commit first (git add -A && git commit -m "First version").';
        return;
      }
    }
    if (!hasRemote) {
      await gitOk(
        ["remote", "add", "uno", `uno::${input.name}`],
        at,
        "Couldn't add the Uno remote",
      );
    }
    const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], at)).stdout.trim();
    await exchange({
      at,
      gitDir,
      branch,
      input,
      result,
      storage,
      meta,
      writeMetaAs: {
        mode: "git",
        remotes: await remotesToShare(at),
        createdBy: ctx.hostname ?? os.hostname(),
      },
      localTime: (file) => commitTimeOf("HEAD", file, at),
      mergeMessage: (from) => `Merge changes from ${from ?? "your other computer"} (Uno sync)`,
      refuseUnrelated: !hasRemote && input.adopt !== true,
      dirtyHint: dirty
        ? "Changes from your other computer touch files you haven't committed here. Commit (or put aside) your changes and it syncs."
        : undefined,
    });
    if (dirty && result.state === "synced") {
      result.message =
        `${result.message} Changes that aren't committed stay on this computer until they are.`.trim();
    }
  } finally {
    await release();
  }
}

/** The repository's other remotes, fit to set up on the other computers. */
async function remotesToShare(/** @type {any} */ at) {
  const out = (await git(["remote", "-v"], at)).stdout;
  /** @type {Record<string, string>} */
  const remotes = {};
  for (const line of out.split("\n")) {
    const [remote, url, kind] = line.split(/\s+/);
    if (!remote || !url || kind !== "(fetch)" || remote === "uno") continue;
    const safe = safeRemoteUrl(url);
    if (safe) remotes[remote] = safe;
  }
  return remotes;
}

/**
 * Exchange the branch with the cloud: fetch, fast-forward or merge, push.
 * Retries when another computer pushed in between.
 * @param {{ at: any, gitDir: string, branch: string, input: SyncInput & { name: string },
 *   result: SyncResult, storage: import("./git-remote-uno.mjs").Storage,
 *   meta: ProjectMeta | null, writeMetaAs: ProjectMeta,
 *   localTime: (file: string) => Promise<number>, mergeMessage: (from: string | null) => string,
 *   refuseUnrelated?: boolean, dirtyHint?: string }} x
 */
async function exchange(x) {
  const { at, branch, result } = x;
  const ref = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/uno/${branch}`;
  /** @type {ConflictRecord | null} */
  let conflict = await readConflict(x.gitDir);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const fetched = await git(
      ["fetch", "-q", "--no-tags", "uno", `+refs/heads/${branch}:${remoteRef}`],
      at,
    );
    // An empty cloud project has no such branch yet: that's fine.
    if (fetched.code !== 0 && !/couldn't find remote ref|no such ref/i.test(fetched.stderr)) {
      throw new SyncError(
        (fetched.stderr.trim().split("\n").at(-1) ?? "Couldn't reach your Uno cloud.").replace(
          /^(fatal|error|uno): /,
          "",
        ),
      );
    }
    if (fetched.code !== 0) await git(["update-ref", "-d", remoteRef], at);
    const local = await revOf(ref, at);
    const remote = await revOf(remoteRef, at);
    let next = local;
    if (remote && local !== remote) {
      if (!local) {
        // This computer has nothing yet: take the cloud's version.
        if (!(await moveTo(ref, null, remote, at))) {
          throw new SyncError(
            "Files in this folder are in the way of the project's own files. Pick an empty folder.",
            "blocked",
          );
        }
        result.pulled = true;
        next = remote;
      } else if (await isAncestor(local, remote, at)) {
        if (!(await moveTo(ref, local, remote, at))) return busy(result, x.dirtyHint);
        result.pulled = true;
        next = remote;
      } else if (!(await isAncestor(remote, local, at))) {
        const related = (await git(["merge-base", local, remote], at)).code === 0;
        if (!related && x.refuseUnrelated) {
          throw new SyncError(
            `"${x.input.name}" in your Uno cloud is a different project. Save this one under another name.`,
            "blocked",
          );
        }
        const from = await theirHost(x.storage, x.input.name);
        const merged = await mergeNewerWins({
          mine: local,
          theirs: remote,
          at,
          gitDir: x.gitDir,
          message: x.mergeMessage(from),
          localTime: x.localTime,
        });
        const commit = (
          await gitOk(
            ["commit-tree", merged.tree, "-p", local, "-p", remote, "-m", x.mergeMessage(from)],
            at,
            "Couldn't merge the changes",
          )
        ).trim();
        if (!(await moveTo(ref, local, commit, at))) return busy(result, x.dirtyHint);
        result.pulled = true;
        next = commit;
        const files = Object.keys(merged.conflicts);
        if (files.length > 0) {
          conflict = {
            files,
            kept: merged.conflicts,
            mine: local,
            theirs: remote,
            theirsFrom: from,
            at: new Date().toISOString(),
          };
          await writeConflict(x.gitDir, conflict);
        }
      }
    }
    if (next && next !== remote) {
      const pushed = await git(["push", "-q", "--no-verify", "uno", `${ref}:${ref}`], at);
      if (pushed.code !== 0) {
        if (/fetch first|non-fast-forward|rejected/i.test(pushed.stderr) && attempt < 3) continue;
        throw new SyncError(
          (pushed.stderr.trim().split("\n").at(-1) ?? "Couldn't save to your Uno cloud.").replace(
            /^(fatal|error|uno): /,
            "",
          ),
          /too big/.test(pushed.stderr) ? "too-big" : "error",
        );
      }
      result.pushed = true;
      await git(["update-ref", remoteRef, next], at);
    }
    if (!x.meta && next) {
      await writeMeta(x.storage, x.input.name, x.writeMetaAs).catch(() => undefined);
    }
    result.head = next;
    result.conflict = conflict;
    result.ok = true;
    result.state = conflict ? "conflict" : "synced";
    result.message = conflict
      ? `${conflict.files.length === 1 ? conflict.files[0] : `${conflict.files.length} files`} changed on both computers; the newer version is kept, the other one is in the history.`
      : result.pulled || result.pushed
        ? "Up to date on all your computers."
        : "Already up to date.";
    return;
  }
  busy(result);
}

/** @param {SyncResult} result @param {string} [hint] */
function busy(result, hint) {
  result.ok = false;
  result.state = hint ? "blocked" : "busy";
  result.message = hint ?? "The folder changed while syncing; it syncs again in a moment.";
}

/** Which computer saved the cloud's version last (a name for messages). */
async function theirHost(
  /** @type {import("./git-remote-uno.mjs").Storage} */ storage,
  /** @type {string} */ name,
) {
  const state = await readRemote(storage, name).catch(() => null);
  return state?.updatedBy?.hostname ?? null;
}

// ── Keep mine / Keep theirs ─────────────────────────────────────────────

/**
 * After a conflict: put the chosen side's version of the conflicted files
 * back (a new version; nothing is lost) and sync. "Dismiss" = keep what won.
 * @param {{ dir: string, name: string, keep: "mine" | "theirs" | "dismiss" }} input
 * @param {Ctx} ctx
 * @returns {Promise<SyncResult>}
 */
export async function resolveConflict(input, ctx) {
  const dir = path.resolve(input.dir);
  // First save what changed here meanwhile, so nothing is overwritten unseen.
  const first = await syncProject({ dir, name: input.name, adopt: true }, ctx);
  if (first.state === "busy") return first;
  const baseEnv = await gitEnv(ctx);
  const own = await ownGit(dir, baseEnv);
  const gitDir = own ? own.gitDir : snapshotGitDir(ctx.home, input.name);
  const env = own ? baseEnv : await gitEnv(ctx, { GIT_DIR: gitDir, GIT_WORK_TREE: dir });
  const at = { env, cwd: own ? own.top : dir };
  const record = await readConflict(gitDir);
  if (record && input.keep !== "dismiss") {
    const release = await lock(gitDir);
    if (!release)
      return {
        ...first,
        state: "busy",
        message: "Another sync of this project is running; try again in a moment.",
      };
    try {
      const source = input.keep === "mine" ? record.mine : record.theirs;
      const branchRef = (await git(["symbolic-ref", "--quiet", "HEAD"], at)).stdout.trim();
      const head = await revOf("HEAD", at);
      if (head && branchRef) {
        /** @type {Map<string, { mode: string, oid: string } | null>} */
        const changes = new Map();
        for (const file of record.files) changes.set(file, await entryAt(source, file, at));
        const tree = await treeWith(head, changes, at, gitDir);
        const headTree = (await gitOk(["rev-parse", `${head}^{tree}`], at, "git")).trim();
        if (tree !== headTree) {
          const what = record.files.length === 1 ? record.files[0] : `${record.files.length} files`;
          const side = input.keep === "mine" ? "this computer's" : "the other computer's";
          const commit = (
            await gitOk(
              ["commit-tree", tree, "-p", head, "-m", `Kept ${side} version of ${what}`],
              at,
              "Couldn't keep that version",
            )
          ).trim();
          if (!(await moveTo(branchRef, head, commit, at))) {
            return {
              ...first,
              state: "busy",
              message: "The folder changed meanwhile; try again in a moment.",
            };
          }
        }
      }
    } finally {
      await release();
    }
  }
  await writeConflict(gitDir, null);
  return syncProject({ dir, name: input.name, adopt: true }, ctx);
}

// ── Get it here ─────────────────────────────────────────────────────────

/**
 * A project from the cloud on this computer: a new folder (default
 * ~/projects/<name>), or the folder it already syncs into (then: sync).
 * @param {{ name: string, dir?: string | null }} input
 * @param {Ctx} ctx
 * @returns {Promise<SyncResult>}
 */
export async function getProject(input, ctx) {
  const dir = path.resolve(input.dir ?? path.join(ctx.home, "projects", input.name));
  const storage = storageOf(ctx);
  const fail = (/** @type {string} */ message, /** @type {SyncState} */ state = "error") => ({
    ok: false,
    name: input.name,
    dir,
    mode: /** @type {"snapshot" | "git"} */ ("snapshot"),
    state,
    pushed: false,
    pulled: false,
    changedFiles: 0,
    head: null,
    conflict: null,
    message,
  });
  try {
    const state = await readRemote(storage, input.name);
    if (Object.keys(state.refs).length === 0) {
      return fail(`There's no project "${input.name}" in your Uno cloud.`, "blocked");
    }
    const meta = await readMeta(storage, input.name);
    const entries = await fsp.readdir(dir).catch(() => null);
    if ((meta?.mode ?? "git") === "snapshot") {
      await fsp.mkdir(dir, { recursive: true });
      return syncProject({ dir, name: input.name, adopt: true }, { ...ctx, storage });
    }
    // A git project: clone it, or sync the clone that's already here.
    const env = await gitEnv(ctx);
    if (entries !== null && entries.length > 0) {
      const own = await ownGit(dir, env);
      if (own && (await remoteName(own.top, env).catch(() => null)) === input.name) {
        return syncProject({ dir, name: input.name }, { ...ctx, storage });
      }
      return fail(
        `${dir} already exists and isn't the project "${input.name}". Pick another folder.`,
        "blocked",
      );
    }
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    await gitOk(
      ["clone", "-q", "-o", "uno", `uno::${input.name}`, dir],
      { env, cwd: path.dirname(dir) },
      `Couldn't get "${input.name}"`,
    );
    for (const [remote, url] of Object.entries(meta?.remotes ?? {})) {
      await git(["remote", "add", remote, url], { env, cwd: dir });
    }
    return syncProject({ dir, name: input.name }, { ...ctx, storage });
  } catch (error) {
    if (!(error instanceof UnoGitError)) throw error;
    return fail(error.message, error instanceof SyncError ? error.state : "error");
  }
}

/**
 * Projects in the cloud with how they sync — for "Projects on your other
 * computers".
 * @param {Ctx} ctx
 */
export async function listCloudProjects(ctx) {
  const storage = storageOf(ctx);
  const projects = await listProjects(storage);
  return Promise.all(
    projects.map(async (project) => ({
      ...project,
      mode: (await readMeta(storage, project.name))?.mode ?? "git",
    })),
  );
}
