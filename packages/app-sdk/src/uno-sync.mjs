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
// in files), node_modules, anything .gitignore lists, what the person keeps
// "only on this computer"; a size cap with a clear message. build/, dist/ and
// out/ stay out only next to a project file (package.json…): anywhere else
// they are the person's own folders and travel like any other.
//
// What leaves is read first. A file with something that looks like a key
// inside waits on this computer and the rest goes; a repository's commits
// can't leave without the file, so there they wait as a whole (the pull still
// happens). The person sees the file's name, never the value.

import { spawn } from "node:child_process";
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
/** Versions of a project shown at most at once, and files listed per version. */
const MAX_HISTORY_PAGE = 200;
const MAX_VERSION_FILES = 30;
/** Entries listed under "Only on this computer". */
const MAX_LOCAL_ENTRIES = 200;

/**
 * Keys by their look. The same list as SECRET_TOKEN_PATTERN in the daemon's
 * apps/server/src/secretRedaction.ts (a test keeps them equal): this file
 * runs on its own, with no imports from the daemon.
 */
export const SECRET_PATTERN = new RegExp(
  [
    // Uno: gateway key, user/agent/box tokens, GPU, refresh.
    String.raw`\b(unollm_|uno_(?:usr|agt|box|gpu|gpc|gps|gpa)_|unor_)[A-Za-z0-9_\-]{12,}`,
    // Anthropic / OpenRouter / OpenAI project keys.
    String.raw`\b(sk-ant-|sk-or-v1-|sk-proj-)[A-Za-z0-9_\-]{16,}`,
    // GitHub.
    String.raw`\b(ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]{20,}`,
  ].join("|"),
);
/** Enough of one read kept for the next, so a key across two reads is seen whole. */
const SCAN_OVERLAP = 96;

/** Skipped only next to a project file: elsewhere a person's own folder of that name. */
export const BUILD_FOLDERS = ["build", "dist", "out"];
/** A file that says "software is built here" for the folder it lies in. */
const PROJECT_FILE_RE =
  /^(package\.json|pyproject\.toml|setup\.py|requirements\.txt|Pipfile|Cargo\.toml|go\.mod|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|Makefile|CMakeLists\.txt|.*\.(sln|csproj))$/;

/**
 * What never travels with a project (git ignore syntax). Keys go through the
 * Uno vault; packages and builds are made again on each computer. BUILD_FOLDERS
 * join this list per folder (`excludesFor`).
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
  ".uno-git.*",
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
 *   theirs: string, theirsFrom: string | null, theirsPerson?: string | null, at: string }} ConflictRecord
 *   theirsPerson: someone else's name, when another person changed the file.
 * @typedef {"synced" | "conflict" | "too-big" | "blocked" | "busy" | "error" | "empty"} SyncState
 * @typedef {{ ok: boolean, name: string, dir: string, mode: "snapshot" | "git", state: SyncState,
 *   pushed: boolean, pulled: boolean, changedFiles: number, head: string | null,
 *   conflict: ConflictRecord | null, held: string[], message: string }} SyncResult
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
 * @typedef {{ home: string, env: NodeJS.ProcessEnv, hostname?: string, person?: string | null,
 *   now?: () => number, storage?: import("./git-remote-uno.mjs").Storage }} Ctx
 *   person: the name on the versions this computer saves.
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
 * Who saved a version: the person and the computer, in the author line
 * ("Misha (macbook)"), which `projectHistory` reads back. Without a known
 * person: "Uno (macbook)".
 */
export function versionAuthor(/** @type {Ctx} */ ctx) {
  return `${personOf(ctx) ?? "Uno"} (${cleanName(ctx.hostname ?? os.hostname()) || "computer"})`;
}

const cleanName = (/** @type {string} */ text) =>
  text
    .replace(/[<>()\n\r\0]/g, "")
    .trim()
    .slice(0, 80);

/** This person's name as versions carry it. */
const personOf = (/** @type {Ctx} */ ctx) => cleanName(ctx.person ?? "") || null;

/** The environment that signs versions as `versionAuthor`. */
function authorEnv(/** @type {Ctx} */ ctx) {
  const name = versionAuthor(ctx);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: "sync@uno4.me",
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: "sync@uno4.me",
  };
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

/** Where a folder without git keeps its hidden history (bare, remote `uno`). */
export const SNAPSHOT_GIT_DIR = ".uno-git";

/**
 * The snapshot repository of a folder without git: inside the folder, so
 * the history moves (and is deleted) with it and every tool finds the
 * project's identity (`remote.uno.url`) in one place.
 */
export function snapshotGitDir(/** @type {string} */ dir) {
  return path.join(dir, SNAPSHOT_GIT_DIR);
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

/**
 * The folder's own git when that is how it syncs. A folder Uno already keeps
 * versions of stays that way when a `.git` appears in it (`git init` by an
 * agent, or for a tool that needs one): saving must not stop.
 */
async function ownGitToSync(/** @type {string} */ dir, /** @type {NodeJS.ProcessEnv} */ env) {
  const snapshot = await fsp.stat(snapshotGitDir(dir)).catch(() => null);
  return snapshot?.isDirectory() ? null : ownGit(dir, env);
}

/**
 * Uno's versions don't belong in a `.git` the folder gets later: a first
 * `git add -A` would carry them, and a push would take them to GitHub.
 */
const keepOutOfOwnGit = (/** @type {string} */ gitDir) =>
  fsp.writeFile(path.join(gitDir, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});

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

// ── What the folder leaves out ──────────────────────────────────────────

const localOnlyFile = (/** @type {string} */ gitDir) => path.join(gitDir, "uno-local-only.json");

/** What the person keeps only on this computer: paths relative to the folder. */
async function readLocalOnly(/** @type {string} */ gitDir) {
  try {
    const raw = JSON.parse(await fsp.readFile(localOnlyFile(gitDir), "utf8"));
    return Array.isArray(raw?.paths)
      ? raw.paths.filter((/** @type {unknown} */ item) => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** One exact path as an ignore pattern, anchored at the folder. */
const exactPattern = (/** @type {string} */ relative) =>
  `/${relative.replace(/[\\*?[\]]/g, "\\$&")}`;

/**
 * BUILD_FOLDERS that lie next to a project file, as ignore patterns: the
 * outermost one on each path. A folder with no project file beside it is the
 * person's own and syncs.
 * @param {string[]} files every file the folder would sync, "/"-separated
 */
export function builtFolders(files) {
  /** @type {Set<string>} */
  const projects = new Set();
  for (const file of files) {
    const slash = file.lastIndexOf("/");
    if (PROJECT_FILE_RE.test(file.slice(slash + 1))) projects.add(file.slice(0, slash + 1));
  }
  /** @type {Set<string>} */
  const built = new Set();
  for (const file of files) {
    const parts = file.split("/").slice(0, -1);
    for (const [index, part] of parts.entries()) {
      if (!BUILD_FOLDERS.includes(part)) continue;
      const parent = parts
        .slice(0, index)
        .map((item) => `${item}/`)
        .join("");
      if (!projects.has(parent)) continue;
      built.add(`${parent}${part}/`);
      break;
    }
  }
  return [...built].toSorted();
}

/**
 * `<gitDir>/info/exclude` as this folder needs it now: the fixed list, what
 * the person keeps here, and the build folders of what is in it today.
 * Rewritten on each sync, so a folder saved under an older list follows too.
 * @param {string} gitDir @param {{ env: NodeJS.ProcessEnv, cwd: string }} at
 */
async function refreshExcludes(gitDir, at) {
  const file = path.join(gitDir, "info", "exclude");
  const fixed = [
    ...DEFAULT_EXCLUDES,
    ...(await readLocalOnly(gitDir)).map((relative) => exactPattern(relative)),
  ];
  const write = async (/** @type {string[]} */ lines) => {
    const next = `${lines.join("\n")}\n`;
    if ((await fsp.readFile(file, "utf8").catch(() => null)) === next) return;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, next);
    await fsp.rename(tmp, file);
  };
  await write(fixed);
  const listed = await gitOk(
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    at,
    "Couldn't list the project's files",
  );
  const built = builtFolders(listed.split("\0").filter(Boolean));
  if (built.length > 0) {
    await write([...fixed, "# Made again on each computer:", ...built.map(exactPattern)]);
  }
}

// ── What leaves is read first ───────────────────────────────────────────

/**
 * Which of `oids` look like they hold a key. Streams `git cat-file --batch`
 * (a blob can be as big as a file can sync: no blob is ever held in memory,
 * and the daemon's loop gets a turn between reads). Text or not doesn't
 * matter: keys are ASCII, so a binary is read the same way. Any failure
 * throws: nothing leaves unread.
 * @param {string[]} oids
 * @param {{ env: NodeJS.ProcessEnv, cwd: string }} at
 * @returns {Promise<Set<string>>}
 */
async function objectsWithKeys(oids, at) {
  /** @type {Set<string>} */
  const found = new Set();
  if (oids.length === 0) return found;
  const failed = () => new SyncError("Couldn't check the project's files before syncing.");
  const child = spawn("git", ["cat-file", "--batch"], {
    cwd: at.cwd,
    env: at.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const closed = new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(`${oids.join("\n")}\n`);
  let header = Buffer.alloc(0);
  /** @type {string | null} */
  let blob = null;
  let left = 0;
  let newline = 0;
  let carry = "";
  for await (const chunk of child.stdout) {
    let offset = 0;
    while (offset < chunk.length) {
      if (left > 0) {
        const take = Math.min(left, chunk.length - offset);
        const text = chunk.toString("latin1", offset, offset + take);
        if (blob !== null && !found.has(blob) && SECRET_PATTERN.test(carry + text)) {
          found.add(blob);
        }
        carry = (carry + text).slice(-SCAN_OVERLAP);
        left -= take;
        offset += take;
        if (left === 0) newline = 1;
        continue;
      }
      if (newline > 0) {
        offset += 1;
        newline = 0;
        continue;
      }
      const end = chunk.indexOf(10, offset);
      if (end < 0) {
        header = Buffer.concat([header, chunk.subarray(offset)]);
        break;
      }
      const line = Buffer.concat([header, chunk.subarray(offset, end)]).toString("latin1");
      header = Buffer.alloc(0);
      offset = end + 1;
      const [id, kind, size] = line.split(" ");
      if (!id || !kind || kind === "missing") throw failed();
      blob = kind === "blob" ? id : null;
      left = Number(size);
      carry = "";
      if (left === 0) newline = 1;
    }
  }
  if ((await closed) !== 0 || left > 0) throw failed();
  return found;
}

/**
 * Read what `git add -A` just staged; a file with a key goes back out of the
 * index, so it stays out of this version and the rest goes. Reads the staged
 * objects, not the files: what's read is exactly what would leave.
 * @param {{ env: NodeJS.ProcessEnv, cwd: string }} at
 * @returns {Promise<string[]>} the files held back
 */
async function holdFilesWithKeys(at) {
  const raw = await gitOk(
    ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames", "--diff-filter=d"],
    at,
    "Couldn't check the project's files before syncing",
  );
  const fields = raw.split("\0");
  /** @type {Map<string, string[]>} */
  const byObject = new Map();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, mode, , oid] = /** @type {string} */ (fields[index]).split(" ");
    const file = /** @type {string} */ (fields[index + 1]);
    if (!oid || mode === "160000") continue;
    byObject.set(oid, [...(byObject.get(oid) ?? []), file]);
  }
  const flagged = await objectsWithKeys([...byObject.keys()], at);
  const held = [...flagged].flatMap((oid) => byObject.get(oid) ?? []).toSorted();
  if (held.length > 0) {
    await gitOk(
      ["--literal-pathspecs", "reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { ...at, input: `${held.join("\0")}\0` },
      "Couldn't check the project's files before syncing",
    );
  }
  return held;
}

const scanFile = (/** @type {string} */ gitDir) => path.join(gitDir, "uno-held.json");

/**
 * A repository: what would leave with `tip` — every object of the commits
 * that aren't on any remote yet, history included (a key taken out in a later
 * commit still leaves with the earlier one). Commits already on a remote
 * aren't read: a clone doesn't start by answering for its whole past.
 * @param {string} tip @param {string} gitDir
 * @param {{ env: NodeJS.ProcessEnv, cwd: string }} at
 * @returns {Promise<string[]>} the files with a key (by name, or by what's inside)
 */
async function keysLeavingWith(tip, gitDir, at) {
  // A held project is looked at on every sync: its answer stays until the tip moves.
  const seen = await fsp
    .readFile(scanFile(gitDir), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  if (seen?.tip === tip && Array.isArray(seen.held)) return seen.held;
  const listed = await gitOk(
    ["-c", "core.quotePath=false", "rev-list", "--objects", tip, "--not", "--remotes"],
    at,
    "Couldn't check the project before syncing",
  );
  /** @type {Set<string>} */
  const held = new Set();
  /** @type {Map<string, string>} */
  const byObject = new Map();
  for (const line of listed.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const file = line.slice(space + 1);
    if (!file) continue;
    if (isKeyFile(file)) held.add(file);
    const oid = line.slice(0, space);
    if (!byObject.has(oid)) byObject.set(oid, file);
  }
  for (const oid of await objectsWithKeys([...byObject.keys()], at)) {
    held.add(/** @type {string} */ (byObject.get(oid)));
  }
  const result = [...held].toSorted();
  await fsp.writeFile(scanFile(gitDir), JSON.stringify({ tip, held: result })).catch(() => {});
  return result;
}

const fileList = (/** @type {string[]} */ files) =>
  `${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`;

/** Calm, and never the value. */
export function heldMessage(/** @type {string[]} */ files) {
  return files.length === 1
    ? `${files[0]} is waiting on this computer: it looks like there's a key in it. Move the key to this project's Keys and the file syncs.`
    : `${files.length} files are waiting on this computer (${fileList(files)}): it looks like there are keys in them. Move the keys to this project's Keys and the files sync.`;
}

/** A repository can't send a file on its own: everything new waits with it. */
function heldInHistoryMessage(/** @type {string[]} */ files) {
  return `New versions of this project are waiting on this computer: it looks like there's a key in ${fileList(files)}. Ask the agent to take it out of the project's history; the key itself goes to this project's Keys.`;
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
  const own = await ownGitToSync(dir, env);
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
    held: [],
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
    throw new SyncError(`This project is linked to ${value}, not to your Uno cloud.`);
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
  const gitDir = snapshotGitDir(input.dir);
  const host = ctx.hostname ?? os.hostname();
  const fresh = !(await fsp.stat(gitDir).catch(() => null));
  if (fresh) await initSnapshot(gitDir, input.name, ctx);
  const env = await gitEnv(ctx, {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: input.dir,
    ...authorEnv(ctx),
  });
  if (!fresh) await pointAt(gitDir, input.name, { env, cwd: input.dir });
  const at = { env, cwd: input.dir };
  const release = await lock(gitDir);
  if (!release) {
    result.state = "busy";
    result.message = "Another sync of this project is running.";
    return;
  }
  try {
    await keepOutOfOwnGit(gitDir);
    await refreshExcludes(gitDir, at);
    await checkSize(at, input.dir);
    await gitOk(["add", "-A"], at, "Couldn't save the project's changes");
    const held = await holdFilesWithKeys(at);
    result.held = held;
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
        `"${input.name}" in your Uno cloud is a different kind of project. Turn sync off and on again to save this folder under another name.`,
        "blocked",
      );
    }
    const local = await revOf("refs/heads/main", at);
    if (!local && !before) {
      const remote = await readRemote(storage, input.name);
      if (Object.keys(remote.refs).length === 0) {
        result.ok = true;
        result.state = "empty";
        result.message =
          held.length > 0 ? heldMessage(held) : "Nothing to sync yet: the folder is empty.";
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
      person: personOf(ctx),
      refuseUnrelated: input.adopt !== true,
      dirtyHint:
        held.length > 0
          ? "Your other computer changed a file that's waiting here because of a key. Move the key to this project's Keys and it syncs."
          : undefined,
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
  const tmp = `${gitDir}.${process.pid}-${Date.now()}.tmp`;
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
 * The folder now syncs under another name (turned off and on as a new
 * project): point `uno` there and forget what the old name's cloud had,
 * so the new name starts from this folder's history alone.
 * @param {string} gitDir @param {string} name @param {{ env: NodeJS.ProcessEnv, cwd: string }} at
 */
async function pointAt(gitDir, name, at) {
  const url = `uno::${name}`;
  const current = (await git(["config", "--get", "remote.uno.url"], at)).stdout.trim();
  if (current === url) return;
  await gitOk(["config", "remote.uno.url", url], at, "Couldn't set up syncing");
  await gitOk(
    ["config", "remote.uno.fetch", "+refs/heads/*:refs/remotes/uno/*"],
    at,
    "Couldn't set up syncing",
  );
  const stale = await git(["for-each-ref", "--format=%(refname)", "refs/remotes/uno/"], at);
  for (const ref of stale.stdout.split("\n").filter(Boolean)) {
    await git(["update-ref", "-d", ref], at);
  }
  await fsp.rm(conflictFile(gitDir), { force: true });
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
      throw new SyncError(
        "This project is on an old version. Ask the agent to go back to the latest one and it syncs.",
        "blocked",
      );
    const head = await revOf("HEAD", at);
    const tracked = head
      ? (await gitOk(["ls-tree", "-r", "-z", "--name-only", "HEAD"], at, "git ls-tree"))
          .split("\0")
          .filter(Boolean)
      : [];
    const keys = tracked.filter(isKeyFile);
    if (keys.length > 0) {
      throw new SyncError(
        `This project's versions keep ${fileList(keys)}. Keys never travel in files: ask the agent to take them out of the project's versions and Uno will sync it; the keys go with it through Uno.`,
        "blocked",
      );
    }
    const hasRemote = (await git(["remote", "get-url", "uno"], at)).code === 0;
    const already = hasRemote ? await remoteName(input.dir, env) : null;
    if (already && already !== input.name) {
      throw new SyncError(`This project already syncs as "${already}".`, "blocked");
    }
    if (!(await git(["config", "user.email"], at)).stdout.trim()) {
      Object.assign(env, authorEnv(ctx));
    }
    const storage = storageOf(ctx);
    const meta = await readMeta(storage, input.name);
    if (meta?.mode === "snapshot") {
      throw new SyncError(
        `"${input.name}" in your Uno cloud is a different kind of project. Turn sync off and on again to save this folder under another name.`,
        "blocked",
      );
    }
    if (!head) {
      const remote = await readRemote(storage, input.name);
      if (Object.keys(remote.refs).length === 0) {
        result.ok = true;
        result.state = "empty";
        result.message =
          "Nothing to sync yet: no version is saved. Ask the agent to save the first one.";
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
      person: personOf(ctx),
      refuseUnrelated: !hasRemote && input.adopt !== true,
      keysLeaving: (tip) => keysLeavingWith(tip, gitDir, at),
      dirtyHint: dirty
        ? "Your other computer changed files you're still working on here. Ask the agent to save your changes as a version and it syncs."
        : undefined,
    });
    if (dirty && result.state === "synced") {
      result.message =
        `${result.message} Changes not saved as a version stay on this computer until they are.`.trim();
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
 *   person: string | null, refuseUnrelated?: boolean, dirtyHint?: string,
 *   keysLeaving?: (tip: string) => Promise<string[]> }} x
 *   keysLeaving: what would leave is read first; with a finding nothing is pushed.
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
            theirsPerson: await otherPerson(remote, files, x.person, at),
            at: new Date().toISOString(),
          };
          await writeConflict(x.gitDir, conflict);
        }
      }
    }
    const leaving = next && next !== remote;
    const waiting = leaving && x.keysLeaving ? await x.keysLeaving(next) : [];
    if (leaving && waiting.length === 0) {
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
    if (!x.meta && next && waiting.length === 0) {
      await writeMeta(x.storage, x.input.name, x.writeMetaAs).catch(() => undefined);
    }
    if (waiting.length > 0) result.held = waiting;
    result.head = next;
    result.conflict = conflict;
    result.ok = true;
    result.state = conflict ? "conflict" : "synced";
    result.message = conflict
      ? `${conflict.files.length === 1 ? conflict.files[0] : `${conflict.files.length} files`} changed on both computers; the newer version is kept, the other one is in the history.`
      : waiting.length > 0
        ? heldInHistoryMessage(waiting)
        : result.held.length > 0
          ? heldMessage(result.held)
          : result.pulled || result.pushed
            ? "Up to date on all your computers."
            : "Already up to date.";
    return;
  }
  busy(result);
}

/**
 * Who changed the first of these files on `tip`, when it wasn't this person:
 * a colleague's change reads differently from one's own other computer.
 * @param {string} tip @param {string[]} files @param {string | null} person
 * @param {{ env: NodeJS.ProcessEnv, cwd: string }} at
 */
async function otherPerson(tip, files, person, at) {
  const out = await git(["log", "-1", "--format=%an%x1f%s", tip, "--", files[0] ?? "."], at);
  const [author = "", subject = ""] = out.stdout.trim().split("\x1f");
  const who = whoSaved(author, subject).person;
  return who && who !== person ? who : null;
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
  const { gitDir, at } = await repositoryOf(dir, ctx);
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
        const what = record.files.length === 1 ? record.files[0] : `${record.files.length} files`;
        const side = input.keep === "mine" ? "this computer's" : "the other computer's";
        const moved = await versionFrom(
          tree,
          { head, branchRef },
          `Kept ${side} version of ${what}`,
          at,
        );
        if (!moved) {
          return {
            ...first,
            state: "busy",
            message: "The folder changed meanwhile; try again in a moment.",
          };
        }
      }
    } finally {
      await release();
    }
  }
  await writeConflict(gitDir, null);
  return syncProject({ dir, name: input.name, adopt: true }, ctx);
}

/**
 * Where a folder's versions are, signed as this person when the repository
 * has no author of its own.
 * @param {string} dir @param {Ctx} ctx
 */
async function repositoryOf(dir, ctx) {
  const env = await gitEnv(ctx);
  const own = await ownGitToSync(dir, env);
  if (own) {
    const at = { env, cwd: own.top };
    if (!(await git(["config", "user.email"], at)).stdout.trim()) {
      Object.assign(env, authorEnv(ctx));
    }
    return { mode: /** @type {const} */ ("git"), gitDir: own.gitDir, at };
  }
  const gitDir = snapshotGitDir(dir);
  const snapshotEnv = await gitEnv(ctx, {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: dir,
    ...authorEnv(ctx),
  });
  return { mode: /** @type {const} */ ("snapshot"), gitDir, at: { env: snapshotEnv, cwd: dir } };
}

/**
 * A new version with this tree on top of `head`; the folder follows.
 * Nothing to do when it already is that tree.
 * @param {string} tree
 * @param {{ head: string, branchRef: string }} on
 * @param {string} message
 * @param {{ env: NodeJS.ProcessEnv, cwd: string }} at
 * @returns {Promise<boolean>} false: the folder changed meanwhile
 */
async function versionFrom(tree, on, message, at) {
  const headTree = (await gitOk(["rev-parse", `${on.head}^{tree}`], at, "git")).trim();
  if (tree === headTree) return true;
  const commit = (
    await gitOk(
      ["commit-tree", tree, "-p", on.head, "-m", message],
      at,
      "Couldn't save that version",
    )
  ).trim();
  return moveTo(on.branchRef, on.head, commit, at);
}

// ── Versions: how the project was ───────────────────────────────────────

/**
 * @typedef {{ path: string, change: "added" | "changed" | "removed" }} VersionFile
 * @typedef {{ id: string, at: string, person: string | null, computer: string | null,
 *   mine: boolean, note: string | null, files: VersionFile[], moreFiles: number }} ProjectVersion
 *   mine: this person saved it, so the list can say "You".
 */

/** "Misha (macbook)" → both; an older "Uno" version → the computer from "Saved on …". */
function whoSaved(/** @type {string} */ author, /** @type {string} */ subject) {
  const match = /^(.*) \(([^()]*)\)$/.exec(author);
  const saved = /^Saved on (.+)$/.exec(subject);
  const person = match ? match[1] : author;
  return {
    person: !person || person === "Uno" ? null : person,
    computer: match?.[2] ?? saved?.[1] ?? null,
  };
}

const CHANGE_OF = /** @type {Record<string, VersionFile["change"]>} */ ({
  A: "added",
  D: "removed",
});

/**
 * The project's versions, newest first, from every computer (a version made
 * when two computers joined isn't one: nobody saved it).
 * @param {{ dir: string, skip?: number, limit?: number }} input
 * @param {Ctx} ctx
 * @returns {Promise<{ mode: "snapshot" | "git", versions: ProjectVersion[], more: boolean }>}
 */
export async function projectHistory(input, ctx) {
  const dir = path.resolve(input.dir);
  const { mode, gitDir, at } = await repositoryOf(dir, ctx);
  if (!(await fsp.stat(gitDir).catch(() => null))) return { mode, versions: [], more: false };
  const limit = Math.min(Math.max(1, input.limit ?? 50), MAX_HISTORY_PAGE);
  const log = await git(
    [
      "-c",
      "core.quotePath=false",
      "log",
      "--no-merges",
      "--no-renames",
      "--name-status",
      "--format=%x1e%H%x1f%ct%x1f%an%x1f%s",
      `--max-count=${limit + 1}`,
      `--skip=${Math.max(0, input.skip ?? 0)}`,
      "HEAD",
      "--",
    ],
    at,
  );
  // No version yet.
  if (log.code !== 0) return { mode, versions: [], more: false };
  const me = personOf(ctx);
  /** @type {ProjectVersion[]} */
  const versions = log.stdout
    .split("\x1e")
    .filter((block) => block.trim())
    .map((block) => {
      const [head = "", ...lines] = block.split("\n");
      const [id = "", time = "0", author = "", subject = ""] = head.split("\x1f");
      const changed = lines.flatMap((line) => {
        const tab = line.indexOf("\t");
        if (tab <= 0) return [];
        return [
          {
            path: line.slice(tab + 1),
            change: CHANGE_OF[line.slice(0, tab)] ?? /** @type {const} */ ("changed"),
          },
        ];
      });
      const who = whoSaved(author, subject);
      return {
        id,
        at: new Date(Number(time) * 1000).toISOString(),
        ...who,
        mine: me !== null && who.person === me,
        note: /^Saved on /.test(subject) ? null : subject || null,
        files: changed.slice(0, MAX_VERSION_FILES),
        moreFiles: Math.max(0, changed.length - MAX_VERSION_FILES),
      };
    });
  return { mode, versions: versions.slice(0, limit), more: versions.length > limit };
}

/** "12 Oct, 14:20", the way the versions list says it. */
function versionDate(/** @type {number} */ seconds) {
  return new Date(seconds * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Bring a version back: the whole project, or some of its files. What is
 * there now is saved first and stays a version, so going back can be undone
 * the same way; the version brought back is a new one, on every computer.
 * @param {{ dir: string, name: string, version: string, files?: string[] | null }} input
 * @param {Ctx} ctx
 * @returns {Promise<SyncResult>}
 */
export async function restoreVersion(input, ctx) {
  const dir = path.resolve(input.dir);
  const first = await syncProject({ dir, name: input.name, adopt: true }, ctx);
  if (first.state === "busy") return first;
  const refuse = (/** @type {string} */ message, /** @type {SyncState} */ state = "blocked") => ({
    ...first,
    ok: false,
    state,
    message,
  });
  if (!/^[0-9a-f]{40,64}$/.test(input.version))
    return refuse("That version isn't in this project.");
  const files = (input.files ?? []).map(safeRelative);
  if (files.includes(null)) return refuse("That file isn't in this project.");
  const { gitDir, at } = await repositoryOf(dir, ctx);
  const release = await lock(gitDir);
  if (!release) return refuse("Another sync of this project is running; try again.", "busy");
  try {
    const branchRef = (await git(["symbolic-ref", "--quiet", "HEAD"], at)).stdout.trim();
    const head = await revOf("HEAD", at);
    const known = head ? await git(["cat-file", "-e", `${input.version}^{commit}`], at) : null;
    if (!head || !branchRef || known?.code !== 0 || !(await isAncestor(input.version, head, at))) {
      return refuse("That version isn't in this project.");
    }
    /** @type {string} */
    let tree;
    /** @type {string} */
    let message;
    const seconds = await commitTimeOf(input.version, null, at);
    if (files.length > 0) {
      /** @type {Map<string, { mode: string, oid: string } | null>} */
      const changes = new Map();
      for (const file of /** @type {string[]} */ (files)) {
        changes.set(file, await entryAt(input.version, file, at));
      }
      tree = await treeWith(head, changes, at, gitDir);
      const what = files.length === 1 ? files[0] : `${files.length} files`;
      message = `Brought back ${what} from ${versionDate(seconds)}`;
    } else {
      tree = (await gitOk(["rev-parse", `${input.version}^{tree}`], at, "git")).trim();
      message = `Went back to ${versionDate(seconds)}`;
    }
    if (!(await versionFrom(tree, { head, branchRef }, message, at))) {
      return refuse("The folder changed meanwhile; try again in a moment.", "busy");
    }
  } finally {
    await release();
  }
  return syncProject({ dir, name: input.name, adopt: true }, ctx);
}

// ── What travels and what stays ─────────────────────────────────────────

/**
 * `git ls-files --directory` names a folder of nothing but ignored files and
 * those files too (`data/`, `data/sample.csv`): one thing, not two. The file
 * stays, it's what the person chose.
 * @param {string[]} entries
 */
function withoutEnclosingFolders(entries) {
  const enclosing = new Set();
  for (const entry of entries) {
    const end = entry.length - 1;
    for (let at = entry.indexOf("/"); at !== -1 && at < end; at = entry.indexOf("/", at + 1)) {
      enclosing.add(entry.slice(0, at + 1));
    }
  }
  return entries.filter((entry) => !enclosing.has(entry));
}

/**
 * The folder's files by what happens to them: how many travel, what stays
 * only on this computer (`yours`: the person chose it; else Uno's rules or
 * the project's own ignore list), and the key files, by name.
 * @param {{ dir: string }} input
 * @param {Ctx} ctx
 * @returns {Promise<{ mode: "snapshot" | "git", synced: number,
 *   localOnly: Array<{ path: string, yours: boolean }>, keyFiles: string[], more: number }>}
 */
export async function projectFiles(input, ctx) {
  const dir = path.resolve(input.dir);
  const { mode, gitDir, at } = await repositoryOf(dir, ctx);
  const none = { mode, synced: 0, localOnly: [], keyFiles: [], more: 0 };
  if (!(await fsp.stat(gitDir).catch(() => null))) return none;
  if (mode === "snapshot") await refreshExcludes(gitDir, at);
  const list = async (/** @type {string[]} */ args) =>
    (await gitOk(["ls-files", "-z", ...args], at, "Couldn't list the project's files"))
      .split("\0")
      .filter(Boolean);
  const synced = new Set(await list(["--cached"]));
  if (mode === "snapshot") {
    for (const file of await list(["--others", "--exclude-standard"])) synced.add(file);
  }
  const ignored = await list(["--others", "--ignored", "--exclude-standard", "--directory"]);
  const yours = new Set(mode === "snapshot" ? await readLocalOnly(gitDir) : []);
  const stays = withoutEnclosingFolders(
    ignored.filter((entry) => !/^\.(uno-)?git(\/|\.|$)/.test(entry)),
  );
  const keyFiles = stays.filter((entry) => isKeyFile(entry.replace(/\/$/, "")));
  const localOnly = stays
    .filter((entry) => !isKeyFile(entry.replace(/\/$/, "")))
    .map((entry) => ({ path: entry, yours: yours.has(entry.replace(/\/$/, "")) }))
    .toSorted((a, b) => Number(b.yours) - Number(a.yours) || a.path.localeCompare(b.path));
  return {
    mode,
    synced: synced.size,
    localOnly: localOnly.slice(0, MAX_LOCAL_ENTRIES),
    keyFiles: keyFiles.slice(0, MAX_LOCAL_ENTRIES),
    more: Math.max(0, localOnly.length - MAX_LOCAL_ENTRIES),
  };
}

/** A folder-relative path, or null when it isn't one inside the folder. */
export function safeRelative(/** @type {unknown} */ raw) {
  if (typeof raw !== "string") return null;
  const relative = raw
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "");
  if (!relative || relative.length > 1024 || /[\n\r\0]/.test(relative)) return null;
  if (path.posix.isAbsolute(relative)) return null;
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return /^\.(uno-)?git$/.test(parts[0] ?? "") ? null : relative;
}

/**
 * Keep a file or folder only on this computer, or let it travel again. A
 * tracked file leaves the project (it is removed from the other computers at
 * the next sync, and stays in the history); the file here is not touched.
 * Only for folders Uno keeps versions of: a repository has its own ignore list.
 * @param {{ dir: string, path: string, localOnly: boolean }} input
 * @param {Ctx} ctx
 */
export async function setLocalOnly(input, ctx) {
  const dir = path.resolve(input.dir);
  const relative = safeRelative(input.path);
  if (!relative) throw new SyncError("That isn't a file in this project.", "blocked");
  const { mode, gitDir, at } = await repositoryOf(dir, ctx);
  if (mode !== "snapshot") {
    throw new SyncError("This project's own rules say what stays on this computer.", "blocked");
  }
  const release = await lock(gitDir);
  if (!release) throw new SyncError("Another sync of this project is running; try again.", "busy");
  try {
    const current = await readLocalOnly(gitDir);
    const others = current.filter((/** @type {string} */ item) => item !== relative);
    const next = input.localOnly ? [...others, relative].toSorted() : others;
    await fsp.writeFile(localOnlyFile(gitDir), `${JSON.stringify({ paths: next }, null, 2)}\n`);
    await refreshExcludes(gitDir, at);
    if (input.localOnly) {
      await gitOk(
        ["--literal-pathspecs", "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", relative],
        at,
        "Couldn't keep that file here",
      );
    }
  } finally {
    await release();
  }
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
    held: [],
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
