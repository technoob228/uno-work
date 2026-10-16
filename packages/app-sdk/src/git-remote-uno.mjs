// git-remote-uno — git repositories in the person's own Uno cloud (Uno Drive),
// so a project moves between their Uno cloud computers with plain git:
//
//   git remote add uno uno::notes && git push uno main     (computer A)
//   git clone -o uno uno::notes ~/projects/notes           (computer B)
//
// A git remote helper (https://git-scm.com/docs/gitremote-helpers): git runs
// `git-remote-uno <remote> <name>` and talks to it over stdin/stdout. Zero
// dependencies, Node >= 18. The Uno Work daemon keeps this file at
// ~/.uno/sdk/js/git-remote-uno.mjs and the launcher ~/.uno/sdk/bin/git-remote-uno
// (on agents' PATH; on cloud computers the global git alias `remote-uno` finds
// it from any terminal too). `uno project ...` (uno-cli.mjs) builds on it.
//
// Storage layout, under a hidden root of the Drive bucket:
//   .uno-git/<name>/refs.json          refs, HEAD and the list of bundles
//   .uno-git/<name>/bundles/<t>.bundle git bundles, each on top of the previous
// A push uploads one bundle of what the cloud doesn't have yet, then rewrites
// refs.json; a fetch unbundles what this repository doesn't have yet.
//
// Bytes go straight between this computer and storage through links the Uno
// console signs, with this computer's own key read from the daemon's
// settings.json — never printed, never written anywhere else. No key (a
// laptop, a computer not signed in to Uno): the helper says so and stops.
//
// Tests only: UNO_GIT_FAKE_STORAGE_DIR=<dir> keeps the "cloud" in a folder.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, realpathSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** The hidden folder of the Drive bucket that holds every project. */
export const GIT_ROOT = ".uno-git/";
/** A project name: what follows `uno::`. */
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** One bundle bigger than this is refused: big files belong in Drive, not git. */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
/** More bundles than this → one full bundle after the push. */
export const COMPACT_MAX_BUNDLES = 20;
/** Test-only switch: the "cloud" is this folder. */
export const FAKE_STORAGE_ENV = "UNO_GIT_FAKE_STORAGE_DIR";
export const DEFAULT_CONSOLE_URL = "https://console.uno4.dev";
/** Where the daemon says its settings.json is (written next to the SDK). */
export const DAEMON_POINTER = ".uno/sdk/daemon.json";

export const NOT_CLOUD = "uno:: remotes work on Uno cloud computers signed in to Uno.";

/** A failure to print as is. */
export class UnoGitError extends Error {}

// ── Names ───────────────────────────────────────────────────────────────

/** `uno::notes`, `notes`, `uno://notes/` → `notes`; null when not a valid name. */
export function projectNameOf(/** @type {string} */ raw) {
  const name = String(raw ?? "")
    .trim()
    .replace(/^uno::/, "")
    .replace(/^uno:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return NAME_RE.test(name) ? name : null;
}

/** A folder name made into a project name ("My App" → "my-app"); null when nothing is left. */
export function slugName(/** @type {string} */ raw) {
  const slug = String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");
  return NAME_RE.test(slug) ? slug : null;
}

const refsKey = (/** @type {string} */ name) => `${GIT_ROOT}${name}/refs.json`;

// ── This computer's key ─────────────────────────────────────────────────

/** @param {string} file */
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The daemon's settings.json on a cloud computer, then on a desktop install. */
export function defaultSettingsFiles(/** @type {string} */ home) {
  return [
    "/var/lib/uno-work/userdata/settings.json",
    path.join(home, ".t3", "userdata", "settings.json"),
  ];
}

/**
 * This computer's console key, from the daemon's settings.json: the file the
 * daemon names in ~/.uno/sdk/daemon.json, else the usual places. Null when
 * the computer isn't an Uno cloud computer signed in to Uno.
 * @param {{ home: string }} where
 * @param {string[]} [fallbacks] where to look when the daemon didn't say
 * @returns {{ token: string, boxId: number | null, consoleUrl: string } | null}
 */
export function machineCredentials(where, fallbacks = defaultSettingsFiles(where.home)) {
  const pointer = readJsonFile(path.join(where.home, DAEMON_POINTER));
  const candidates = [
    typeof pointer?.settingsPath === "string" ? pointer.settingsPath : null,
    ...fallbacks,
  ].filter((file) => typeof file === "string" && file.length > 0);
  for (const file of candidates) {
    const uno = readJsonFile(/** @type {string} */ (file))?.uno;
    const token = typeof uno?.boxToken === "string" ? uno.boxToken.trim() : "";
    if (!token) continue;
    const boxId = Number(uno.boxId);
    const consoleUrl =
      typeof pointer?.consoleUrl === "string" && /^https?:\/\//.test(pointer.consoleUrl)
        ? pointer.consoleUrl
        : DEFAULT_CONSOLE_URL;
    return {
      token,
      boxId: Number.isSafeInteger(boxId) && boxId > 0 ? boxId : null,
      consoleUrl: consoleUrl.replace(/\/+$/, ""),
    };
  }
  return null;
}

// ── Storage: the Drive bucket through the console, or a folder (tests) ──

/**
 * @typedef {{
 *   read(key: string): Promise<Buffer | null>,
 *   download(key: string, file: string): Promise<boolean>,
 *   write(key: string, bytes: Buffer): Promise<void>,
 *   upload(key: string, file: string, size: number): Promise<void>,
 *   list(prefix: string): Promise<{ folders: string[], objects: Array<{ key: string, size: number }> }>,
 *   remove(key: string): Promise<void>,
 *   who: { boxId: number | null, hostname: string },
 * }} Storage
 */

/**
 * The storage this process uses: the fake folder in tests, else the Drive.
 * @param {{ home: string, env: NodeJS.ProcessEnv }} where
 * @returns {Storage}
 */
export function openStorage(where) {
  const fake = where.env[FAKE_STORAGE_ENV]?.trim();
  if (fake) return folderStorage(fake);
  const creds = machineCredentials(where);
  if (!creds) throw new UnoGitError(NOT_CLOUD);
  return consoleStorage(creds);
}

/** @param {string} root @returns {Storage} */
export function folderStorage(root) {
  const fileOf = (/** @type {string} */ key) => {
    const file = path.resolve(root, key);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new UnoGitError(`Bad key ${key}`);
    return file;
  };
  const place = async (
    /** @type {string} */ key,
    /** @type {(tmp: string) => Promise<void>} */ fill,
  ) => {
    const file = fileOf(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fill(tmp);
    await fsp.rename(tmp, file);
  };
  return {
    who: { boxId: null, hostname: os.hostname() },
    read: (key) => fsp.readFile(fileOf(key)).catch(() => null),
    download: (key, file) =>
      fsp.copyFile(fileOf(key), file).then(
        () => true,
        () => false,
      ),
    write: (key, bytes) => place(key, (tmp) => fsp.writeFile(tmp, bytes)),
    upload: (key, file) => place(key, (tmp) => fsp.copyFile(file, tmp)),
    list: async (prefix) => {
      const dir = path.join(root, prefix);
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const folders = [];
      const objects = [];
      for (const entry of entries) {
        if (entry.isDirectory()) folders.push(`${prefix}${entry.name}/`);
        else if (!entry.name.endsWith(".tmp")) {
          const stats = await fsp.stat(path.join(dir, entry.name));
          objects.push({ key: `${prefix}${entry.name}`, size: stats.size });
        }
      }
      return { folders, objects };
    },
    remove: (key) => fsp.rm(fileOf(key), { recursive: true, force: true }),
  };
}

/** What a console status means here. */
function consoleMessage(/** @type {number} */ status, /** @type {string} */ body) {
  if (status === 401) return "The Uno console didn't accept this computer's key.";
  if (status === 402 || /STORAGE_QUOTA_EXCEEDED/.test(body))
    return "Your Uno cloud storage is full. Free up space or upgrade your plan.";
  if (status === 403) return "This computer's key isn't allowed to use Uno cloud storage.";
  if (status === 404 && /DRIVE_NOT_CONFIGURED/.test(body))
    return "Uno Drive isn't available on this Uno console yet.";
  return `Uno cloud storage answered ${status}.`;
}

const PRESIGN_TTL = 3600;
const PUT_ATTEMPTS = 4;
const PART_CONCURRENCY = 2;

/**
 * The person's Drive bucket through the console (`/api/v1/drive`, bucket
 * presign/objects routes — the ones the daemon's Files use).
 * @param {{ token: string, boxId: number | null, consoleUrl: string }} creds
 * @param {typeof fetch} [fetchImpl]
 * @returns {Storage}
 */
export function consoleStorage(creds, fetchImpl = fetch) {
  /** @param {string} route @param {RequestInit} [init] */
  const api = async (route, init = {}) => {
    let response;
    try {
      response = await fetchImpl(`${creds.consoleUrl}${route}`, {
        ...init,
        headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new UnoGitError("Couldn't reach the Uno console. Check the internet connection.");
    }
    const text = await response.text();
    if (!response.ok) throw new UnoGitError(consoleMessage(response.status, text));
    try {
      return JSON.parse(text);
    } catch {
      throw new UnoGitError("The Uno console answered something unexpected.");
    }
  };
  /** @type {Promise<number> | null} */
  let bucket = null;
  const bucketId = () =>
    (bucket ??= api("/api/v1/drive").then((drive) => {
      if (typeof drive?.bucket_id !== "number") {
        throw new UnoGitError("Uno Drive isn't set up for this account yet.");
      }
      return drive.bucket_id;
    }));
  /** @param {Record<string, unknown>} body */
  const presign = async (body) =>
    api(`/api/v1/buckets/${await bucketId()}/presign`, {
      method: "POST",
      body: JSON.stringify({ ttl: PRESIGN_TTL, ...body }),
    });
  const getUrl = async (/** @type {string} */ key) => {
    const url = (await presign({ key, method: "get" }))?.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
      throw new UnoGitError("The Uno console didn't return a download link.");
    }
    return url;
  };
  /** One GET of a stored object; null when it doesn't exist. */
  const get = async (/** @type {string} */ key) => {
    const response = await fetchImpl(await getUrl(key)).catch(() => null);
    if (!response) throw new UnoGitError("Couldn't reach Uno cloud storage.");
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new UnoGitError(`Uno cloud storage answered ${response.status} for ${key}.`);
    }
    return response;
  };

  /**
   * PUT with retries. `body()` gives a fresh body each try.
   * @param {string} url
   * @param {() => { body: Buffer | ReadableStream, length: number }} make
   * @returns {Promise<number>} 0 on success, else the last status (0 = network)
   */
  const put = async (url, make, attempts = PUT_ATTEMPTS) => {
    let status = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const { body, length } = make();
      const response = await fetchImpl(url, {
        method: "PUT",
        body: /** @type {any} */ (body),
        headers: { "content-length": String(length) },
        ...(Buffer.isBuffer(body) ? {} : { duplex: "half" }),
      }).catch(() => null);
      await response?.body?.cancel().catch(() => undefined);
      if (response?.ok) return -1;
      status = response?.status ?? 0;
      if (status !== 0 && status !== 408 && status !== 429 && status < 500) return status;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
    return status;
  };
  const putFailed = (/** @type {number} */ status) =>
    new UnoGitError(
      status === 0
        ? "Couldn't reach Uno cloud storage while uploading."
        : `Uno cloud storage refused the upload (${status}).`,
    );

  /**
   * Upload `size` bytes: one PUT, or parts when the console says so
   * (big files on storage with a small single-PUT limit).
   * @param {string} key
   * @param {number} size
   * @param {(start: number, end: number) => () => { body: Buffer | ReadableStream, length: number }} range
   */
  const uploadRange = async (key, size, range) => {
    const plan = await presign({ key, method: "put", size });
    if (plan?.multipart !== true) {
      if (typeof plan?.url !== "string") {
        throw new UnoGitError("The Uno console didn't return an upload link.");
      }
      const status = await put(plan.url, range(0, size));
      if (status !== -1) throw putFailed(status);
      return;
    }
    const uploadId = String(plan.upload_id ?? "");
    const partSize = Number(plan.part_size);
    const parts = Number(plan.parts);
    const abort = () => presign({ key, method: "abort", upload_id: uploadId }).catch(() => {});
    if (!uploadId || !(partSize > 0) || parts !== Math.ceil(size / partSize)) {
      await abort();
      throw new UnoGitError("The Uno console's upload plan doesn't match the file.");
    }
    /** @type {Map<number, string>} */
    const urls = new Map();
    const remember = (/** @type {any} */ answer) => {
      const first = Number(answer?.first) || 1;
      (Array.isArray(answer?.part_urls) ? answer.part_urls : []).forEach(
        (/** @type {unknown} */ url, /** @type {number} */ index) => {
          if (typeof url === "string") urls.set(first + index, url);
        },
      );
    };
    remember(plan);
    let next = 1;
    const worker = async () => {
      while (next <= parts) {
        const part = next;
        next += 1;
        const start = (part - 1) * partSize;
        const make = range(start, Math.min(size, start + partSize));
        for (let resigned = 0; ; resigned += 1) {
          if (!urls.has(part)) {
            remember(
              await presign({
                key,
                method: "put",
                upload_id: uploadId,
                first: part,
                last: Math.min(parts, part + 63),
              }),
            );
          }
          const url = urls.get(part);
          if (!url) throw new UnoGitError(`The Uno console didn't sign part ${part}.`);
          const status = await put(url, make);
          if (status === -1) break;
          // 403: the link expired (a long upload) — sign it again, once.
          if (status === 403 && resigned === 0) {
            urls.delete(part);
            continue;
          }
          throw putFailed(status);
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts) }, worker));
      await presign({ key, method: "complete", upload_id: uploadId });
    } catch (error) {
      await abort();
      throw error;
    }
  };

  return {
    who: { boxId: creds.boxId, hostname: os.hostname() },
    read: async (key) => {
      const response = await get(key);
      return response ? Buffer.from(await response.arrayBuffer()) : null;
    },
    download: async (key, file) => {
      const response = await get(key);
      if (!response) return false;
      await pipeline(Readable.fromWeb(/** @type {any} */ (response.body)), createWriteStream(file));
      return true;
    },
    write: (key, bytes) =>
      uploadRange(key, bytes.length, (start, end) => () => ({
        body: bytes.subarray(start, end),
        length: end - start,
      })),
    upload: (key, file, size) =>
      uploadRange(key, size, (start, end) => () => ({
        body:
          end <= start
            ? Buffer.alloc(0)
            : /** @type {ReadableStream} */ (
                Readable.toWeb(createReadStream(file, { start, end: end - 1 }))
              ),
        length: end - start,
      })),
    list: async (prefix) => {
      const raw = await api(
        `/api/v1/buckets/${await bucketId()}/objects?prefix=${encodeURIComponent(prefix)}`,
      );
      return {
        folders: (Array.isArray(raw?.folders) ? raw.folders : []).filter(
          (/** @type {unknown} */ folder) => typeof folder === "string",
        ),
        objects: (Array.isArray(raw?.objects) ? raw.objects : []).flatMap(
          (/** @type {any} */ object) =>
            typeof object?.key === "string"
              ? [{ key: object.key, size: Number(object.size) || 0 }]
              : [],
        ),
      };
    },
    remove: async (key) => {
      await api(`/api/v1/buckets/${await bucketId()}/objects?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
    },
  };
}

// ── The remote's state (refs.json) ──────────────────────────────────────

/**
 * @typedef {{ key: string, created: string, size: number, tips: Record<string, string>,
 *   prerequisites: string[] }} BundleEntry
 * @typedef {{ version: 1, refs: Record<string, string>, head: string | null,
 *   bundles: BundleEntry[], updatedAt: string | null, rev: string | null,
 *   updatedBy: { boxId: number | null, hostname: string } | null }} RemoteState
 */

/** @returns {RemoteState} */
export function emptyState() {
  return {
    version: 1,
    refs: {},
    head: null,
    bundles: [],
    updatedAt: null,
    rev: null,
    updatedBy: null,
  };
}

/**
 * @param {Storage} storage
 * @param {string} name
 * @returns {Promise<RemoteState>}
 */
export async function readRemote(storage, name) {
  const raw = await storage.read(refsKey(name));
  if (!raw) return emptyState();
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new UnoGitError(`The Uno cloud copy of "${name}" is damaged (refs.json).`);
  }
  if (parsed?.version !== 1) {
    throw new UnoGitError(
      `The Uno cloud copy of "${name}" was saved by a newer Uno Work. Update Uno Work on this computer.`,
    );
  }
  return {
    ...emptyState(),
    ...parsed,
    refs: { ...parsed.refs },
    bundles: Array.isArray(parsed.bundles) ? parsed.bundles : [],
  };
}

/**
 * Every project in the person's Uno cloud, newest first.
 * @param {Storage} storage
 */
export async function listProjects(storage) {
  const { folders } = await storage.list(GIT_ROOT);
  const names = folders
    .map((folder) => folder.slice(GIT_ROOT.length).replace(/\/$/, ""))
    .filter((name) => NAME_RE.test(name));
  const projects = await Promise.all(
    names.map(async (name) => {
      const state = await readRemote(storage, name).catch(() => null);
      return {
        name,
        branches: state
          ? Object.keys(state.refs).filter((ref) => ref.startsWith("refs/heads/")).length
          : 0,
        head: state?.head ?? null,
        updatedAt: state?.updatedAt ?? null,
        updatedBy: state?.updatedBy ?? null,
      };
    }),
  );
  return projects
    .filter((project) => project.updatedAt !== null)
    .toSorted((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// ── git ─────────────────────────────────────────────────────────────────

/**
 * Run git; never throws for a non-zero exit.
 * @param {string[]} args
 * @param {{ input?: string, env?: NodeJS.ProcessEnv, cwd?: string }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function git(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: 127, stdout, stderr: String(error.message) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

/** @param {string[]} args @param {string} what */
async function gitOk(args, what) {
  const result = await git(args);
  if (result.code !== 0) {
    throw new UnoGitError(`${what} failed: ${result.stderr.trim().split("\n").at(-1) ?? ""}`);
  }
  return result.stdout;
}

/** Which of `ids` this repository has. */
async function presentObjects(/** @type {Iterable<string>} */ ids) {
  const unique = [...new Set(ids)];
  /** @type {Set<string>} */
  const present = new Set();
  if (unique.length === 0) return present;
  const { stdout } = await git(["cat-file", "--batch-check"], { input: `${unique.join("\n")}\n` });
  for (const line of stdout.split("\n")) {
    const [id, kind] = line.split(" ");
    if (id && kind && kind !== "missing") present.add(id);
  }
  return present;
}

/** The prerequisites (`-<sha>` lines) of a bundle file's header. */
async function bundlePrerequisites(/** @type {string} */ file) {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(1 << 16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("latin1");
    const header = text.slice(0, Math.max(0, text.indexOf("\n\n")));
    return header
      .split("\n")
      .filter((line) => line.startsWith("-"))
      .map((line) => line.slice(1).split(" ")[0] ?? "")
      .filter((id) => /^[0-9a-f]{40,64}$/.test(id));
  } finally {
    await handle.close();
  }
}

/**
 * A bundle of `tips` (and what they reach) minus what `exclude` reaches;
 * false when there is nothing new. Tips get temporary refs (a bundle only
 * names refs), dropped right after.
 * @param {string} file
 * @param {string[]} tips
 * @param {string[]} exclude
 * @param {boolean} progress
 */
async function createBundle(file, tips, exclude, progress) {
  const tag = `${process.pid}-${randomBytes(3).toString("hex")}`;
  const refs = tips.map((_, index) => `refs/uno-tmp/${tag}/${index}`);
  const updates = refs.map((ref, index) => `update ${ref} ${tips[index]}\n`).join("");
  const made = await git(["update-ref", "--stdin"], { input: updates });
  if (made.code !== 0) throw new UnoGitError(`git update-ref failed: ${made.stderr.trim()}`);
  try {
    const result = await git([
      "bundle",
      "create",
      ...(progress ? [] : ["--quiet"]),
      file,
      ...refs,
      ...exclude.map((id) => `^${id}`),
    ]);
    if (result.code === 0) return true;
    if (/empty bundle/i.test(result.stderr)) return false;
    throw new UnoGitError(`git bundle create failed: ${result.stderr.trim()}`);
  } finally {
    await git(["update-ref", "--stdin"], {
      input: refs.map((ref) => `delete ${ref}\n`).join(""),
    });
  }
}

const stamp = () =>
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;

const megabytes = (/** @type {number} */ bytes) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1048576).toFixed(1)} MB`;

// ── The helper ──────────────────────────────────────────────────────────

/**
 * One helper session: the commands git sends on `input`, answers on `output`.
 * @param {{ name: string, storage: () => Storage, gitDir: string,
 *   input: NodeJS.ReadableStream, output: NodeJS.WritableStream, log: (line: string) => void }} io
 */
export async function serve(io) {
  const lines = readline.createInterface({ input: io.input, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const nextLine = async () => {
    const step = await iterator.next();
    return step.done ? null : step.value;
  };
  const options = { verbosity: 1, progress: false, force: false, dryRun: false };
  /** @type {Storage | null} */
  let storage = null;
  const store = () => (storage ??= io.storage());
  const tmpDir = path.join(io.gitDir, "uno", "tmp");
  /** @type {RemoteState | null} */
  let listed = null;
  const say = (/** @type {string} */ line) => {
    if (options.verbosity > 0) io.log(line);
  };

  /** Collect a batch: this line and the ones up to a blank line. */
  const batch = async (/** @type {string} */ first) => {
    const out = [first];
    for (;;) {
      const line = await nextLine();
      if (line === null || line === "") return out;
      out.push(line);
    }
  };

  for (;;) {
    const line = await nextLine();
    if (line === null || line === "") break;
    if (line === "capabilities") {
      io.output.write("option\nfetch\npush\n\n");
    } else if (line.startsWith("option ")) {
      const [, key, value = ""] = line.split(" ");
      if (key === "verbosity") options.verbosity = Number(value) || 0;
      else if (key === "progress") options.progress = value === "true";
      else if (key === "force") options.force = value === "true";
      else if (key === "dry-run") options.dryRun = value === "true";
      else {
        io.output.write("unsupported\n");
        continue;
      }
      io.output.write("ok\n");
    } else if (line === "list" || line === "list for-push") {
      listed = await readRemote(store(), io.name);
      const out = Object.entries(listed.refs)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([ref, id]) => `${id} ${ref}\n`);
      if (listed.head && listed.refs[listed.head]) out.push(`@${listed.head} HEAD\n`);
      io.output.write(`${out.join("")}\n`);
    } else if (line.startsWith("fetch ")) {
      const wants = (await batch(line)).map((item) => item.split(" ")[1] ?? "").filter(Boolean);
      await fetchObjects({
        storage: store(),
        name: io.name,
        wants,
        tmpDir,
        listed,
        say,
        progress: options.progress,
      });
      io.output.write("\n");
    } else if (line.startsWith("push ")) {
      const specs = (await batch(line)).map((item) => {
        const spec = item.slice("push ".length);
        const force = spec.startsWith("+");
        const [src = "", dst = ""] = (force ? spec.slice(1) : spec).split(":");
        return { force, src, dst };
      });
      const results = await pushRefs({
        storage: store(),
        name: io.name,
        specs,
        tmpDir,
        force: options.force,
        dryRun: options.dryRun,
        progress: options.progress,
        say,
      });
      io.output.write(
        `${specs
          .map(({ dst }) => {
            const error = results.get(dst);
            return error ? `error ${dst} ${error}\n` : `ok ${dst}\n`;
          })
          .join("")}\n`,
      );
    } else {
      throw new UnoGitError(`Unknown command from git: ${line}`);
    }
  }
  lines.close();
}

/**
 * Unbundle, oldest first, the bundles this repository is missing until it
 * has every wanted object. A bundle whose tips are all here is skipped.
 * @param {{ storage: Storage, name: string, wants: string[], tmpDir: string,
 *   listed: RemoteState | null, say: (line: string) => void, progress: boolean }} input
 */
export async function fetchObjects(input) {
  for (let attempt = 1; ; attempt += 1) {
    const state =
      attempt === 1 && input.listed ? input.listed : await readRemote(input.storage, input.name);
    const tips = state.bundles.flatMap((bundle) => Object.values(bundle.tips));
    const present = await presentObjects([...input.wants, ...tips]);
    const missing = () => input.wants.filter((id) => !present.has(id));
    if (missing().length === 0) return;
    const needed = [];
    for (const bundle of state.bundles) {
      if (Object.values(bundle.tips).every((id) => present.has(id))) continue;
      needed.push(bundle);
    }
    const total = needed.reduce((sum, bundle) => sum + (Number(bundle.size) || 0), 0);
    if (input.progress && needed.length > 0) {
      input.say(`uno: downloading ${input.name} from your Uno cloud (${megabytes(total)})`);
    }
    await fsp.mkdir(input.tmpDir, { recursive: true });
    let vanished = false;
    for (const bundle of needed) {
      if (missing().length === 0) break;
      if (Object.values(bundle.tips).every((id) => present.has(id))) continue;
      const file = path.join(input.tmpDir, `${stamp()}.bundle`);
      try {
        if (!(await input.storage.download(bundle.key, file))) {
          vanished = true;
          break;
        }
        await gitOk(["bundle", "unbundle", file], "git bundle unbundle");
      } finally {
        await fsp.rm(file, { force: true });
      }
      for (const id of Object.values(bundle.tips)) present.add(id);
    }
    // Packed again by a push from another computer meanwhile: read the new list once.
    if (vanished && attempt === 1) continue;
    const still = await presentObjects(input.wants);
    const lost = input.wants.filter((id) => !still.has(id));
    if (lost.length === 0) return;
    throw new UnoGitError(
      vanished
        ? `The Uno cloud copy of "${input.name}" changed while downloading. Try again.`
        : `The Uno cloud copy of "${input.name}" is missing ${lost[0]}.`,
    );
  }
}

/** The ref HEAD should name after an update. */
async function chooseHead(
  /** @type {RemoteState} */ state,
  /** @type {string | null} */ preferred,
) {
  if (state.head && state.refs[state.head]) return state.head;
  const heads = Object.keys(state.refs)
    .filter((ref) => ref.startsWith("refs/heads/"))
    .toSorted();
  if (preferred && heads.includes(preferred)) return preferred;
  return (
    ["refs/heads/main", "refs/heads/master"].find((ref) => heads.includes(ref)) ?? heads[0] ?? null
  );
}

/**
 * Push: check each ref, upload one bundle of what's new, then rewrite
 * refs.json (re-read just before, so a push from another computer meanwhile
 * is noticed). Returns dst → error text (absent = ok).
 * @param {{ storage: Storage, name: string, specs: Array<{ force: boolean, src: string, dst: string }>,
 *   tmpDir: string, force: boolean, dryRun: boolean, progress: boolean, say: (line: string) => void }} input
 * @returns {Promise<Map<string, string>>}
 */
export async function pushRefs(input) {
  /** @type {Map<string, string>} */
  const errors = new Map();
  const before = await readRemote(input.storage, input.name);
  /** @type {Array<{ dst: string, id: string | null }>} */
  const updates = [];
  for (const spec of input.specs) {
    const { dst } = spec;
    if (!dst.startsWith("refs/")) {
      errors.set(dst, "only full ref names can be pushed");
      continue;
    }
    const old = before.refs[dst] ?? null;
    if (spec.src === "") {
      if (old !== null) updates.push({ dst, id: null });
      continue;
    }
    const resolved = await git(["rev-parse", "--verify", "--quiet", spec.src]);
    const id = resolved.stdout.trim();
    if (resolved.code !== 0 || !id) {
      errors.set(dst, `${spec.src} doesn't name a commit here`);
      continue;
    }
    if (old === id) continue;
    if (old !== null && !(spec.force || input.force)) {
      if (dst.startsWith("refs/tags/")) {
        errors.set(dst, "already exists");
        continue;
      }
      if ((await presentObjects([old])).size === 0) {
        errors.set(dst, "fetch first");
        continue;
      }
      if ((await git(["merge-base", "--is-ancestor", old, id])).code !== 0) {
        errors.set(dst, "non-fast-forward");
        continue;
      }
    }
    updates.push({ dst, id });
  }
  if (updates.length === 0 || input.dryRun) return errors;
  const failAll = (/** @type {string} */ why) => {
    for (const update of updates) errors.set(update.dst, why);
    return errors;
  };

  /** @type {BundleEntry | null} */
  let entry = null;
  const tips = [...new Set(updates.flatMap((update) => (update.id ? [update.id] : [])))];
  if (tips.length > 0) {
    await fsp.mkdir(input.tmpDir, { recursive: true });
    const file = path.join(input.tmpDir, `${stamp()}.bundle`);
    try {
      const exclude = [...(await presentObjects(Object.values(before.refs)))];
      if (await createBundle(file, tips, exclude, input.progress)) {
        const { size } = await fsp.stat(file);
        if (size > MAX_BUNDLE_BYTES) {
          input.say(
            `uno: this push is ${megabytes(size)}; one push to your Uno cloud can be at most 2 GB. Keep big files (videos, datasets, archives) in Uno Drive, not in git.`,
          );
          return failAll("too big for the Uno cloud (over 2 GB in one push)");
        }
        if (input.progress) input.say(`uno: saving ${megabytes(size)} to your Uno cloud`);
        const key = `${GIT_ROOT}${input.name}/bundles/${stamp()}.bundle`;
        await input.storage.upload(key, file, size);
        entry = {
          key,
          created: new Date().toISOString(),
          size,
          tips: Object.fromEntries(updates.flatMap((u) => (u.id ? [[u.dst, u.id]] : []))),
          prerequisites: await bundlePrerequisites(file),
        };
      }
    } finally {
      await fsp.rm(file, { force: true });
    }
  }

  // Commit: the remote must still be what we built on.
  const current = await readRemote(input.storage, input.name);
  if (current.rev !== before.rev) {
    const moved = updates.some(
      (update) => (current.refs[update.dst] ?? null) !== (before.refs[update.dst] ?? null),
    );
    const repacked = before.bundles.some(
      (bundle) => !current.bundles.some((other) => other.key === bundle.key),
    );
    if (moved || repacked) {
      if (entry) await input.storage.remove(entry.key).catch(() => undefined);
      return failAll("fetch first");
    }
  }
  /** @type {RemoteState} */
  const next = { ...current, refs: { ...current.refs }, bundles: [...current.bundles] };
  for (const update of updates) {
    if (update.id === null) delete next.refs[update.dst];
    else next.refs[update.dst] = update.id;
  }
  if (entry) next.bundles.push(entry);
  const dropped = Object.keys(next.refs).length === 0 ? next.bundles.splice(0) : [];
  const branch = (await git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() || null;
  next.head = await chooseHead(next, branch);
  next.updatedAt = new Date().toISOString();
  next.rev = randomBytes(8).toString("hex");
  next.updatedBy = input.storage.who;
  await input.storage.write(refsKey(input.name), Buffer.from(`${JSON.stringify(next, null, 2)}\n`));
  for (const bundle of dropped) await input.storage.remove(bundle.key).catch(() => undefined);

  await compact({ ...input, state: next }).catch((error) =>
    input.say(
      `uno: couldn't pack ${input.name} in your Uno cloud (${error.message}); it still works.`,
    ),
  );
  return errors;
}

/**
 * Many bundles, or bundles much bigger than the last full one: replace them
 * with one full bundle of every ref (only when this repository has them all).
 * @param {{ storage: Storage, name: string, state: RemoteState, tmpDir: string, progress: boolean }} input
 */
export async function compact(input) {
  const { state } = input;
  if (state.bundles.length < 2) return false;
  const full = state.bundles.findLast((bundle) => bundle.prerequisites.length === 0);
  const total = state.bundles.reduce((sum, bundle) => sum + (Number(bundle.size) || 0), 0);
  if (!(state.bundles.length > COMPACT_MAX_BUNDLES || (full && total > 2 * full.size)))
    return false;
  const tips = [...new Set(Object.values(state.refs))];
  if ((await presentObjects(tips)).size !== tips.length) return false;
  await fsp.mkdir(input.tmpDir, { recursive: true });
  const file = path.join(input.tmpDir, `${stamp()}.bundle`);
  try {
    if (!(await createBundle(file, tips, [], input.progress))) return false;
    const { size } = await fsp.stat(file);
    if (size > MAX_BUNDLE_BYTES) return false;
    const key = `${GIT_ROOT}${input.name}/bundles/${stamp()}.bundle`;
    await input.storage.upload(key, file, size);
    const current = await readRemote(input.storage, input.name);
    if (current.rev !== state.rev) {
      await input.storage.remove(key).catch(() => undefined);
      return false;
    }
    /** @type {RemoteState} */
    const next = {
      ...state,
      bundles: [
        {
          key,
          created: new Date().toISOString(),
          size,
          tips: { ...state.refs },
          prerequisites: [],
        },
      ],
      rev: randomBytes(8).toString("hex"),
    };
    await input.storage.write(
      refsKey(input.name),
      Buffer.from(`${JSON.stringify(next, null, 2)}\n`),
    );
    for (const bundle of state.bundles)
      await input.storage.remove(bundle.key).catch(() => undefined);
    return true;
  } finally {
    await fsp.rm(file, { force: true });
  }
}

/**
 * `git-remote-uno <remote> [<url>]` as git runs it.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [options]
 */
export async function main(argv, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const name = projectNameOf(argv[1] ?? argv[0] ?? "");
  try {
    if (!name) {
      throw new UnoGitError(
        `"${argv[1] ?? argv[0] ?? ""}" isn't an Uno project name: use uno::<name> with a-z, 0-9, ".", "_", "-".`,
      );
    }
    await serve({
      name,
      storage: () => openStorage({ home, env }),
      gitDir: path.resolve(env.GIT_DIR ?? ".git"),
      input: process.stdin,
      output: process.stdout,
      log: (line) => process.stderr.write(`${line}\n`),
    });
  } catch (error) {
    process.stderr.write(`uno: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function invokedDirectly() {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main(process.argv.slice(2));
