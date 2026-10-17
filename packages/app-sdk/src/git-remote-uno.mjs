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
//   .uno-git/<name>/log/<seq>.json      the state after each change: refs, HEAD,
//                                       bundles (seq zero-padded to 12; the
//                                       highest is current; last 50 kept)
//   .uno-git/<name>/bundles/<t>.bundle  git bundles, each on top of earlier ones
//
// Two computers pushing at once can't lose each other's work: a new state is
// written only to a log entry that doesn't exist yet (If-None-Match: *), so
// exactly one of them gets seq N+1; the other re-reads, re-checks
// fast-forward and tries once more, or answers "fetch first". Nothing a
// push uploaded is deleted by that push: bundles no current state names go
// only once they are an hour old by storage's clock (a push in flight has 30
// minutes to name its bundle), and so do log entries more than 50 behind.
//
// Bytes go straight between this computer and storage through links the Uno
// console signs, with this computer's own key read from the daemon's
// settings.json — never printed, never written anywhere else. No key (a
// laptop, a computer not signed in to Uno): the helper says so and stops.
//
// Tests only: UNO_GIT_FAKE_STORAGE_DIR=<dir> keeps the "cloud" in a folder
// (UNO_GIT_FAKE_STORAGE_DELAY_MS=<ms> waits up to that long before each
// conditional write, to make pushes race).

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync, realpathSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import { Readable, Transform } from "node:stream";
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
/** Log entries kept. */
export const LOG_KEEP = 50;
/** A bundle no state names is deleted only once it is older than this. */
export const BUNDLE_GC_AGE_MS = 60 * 60_000;
/**
 * A push whose bundle started going up longer ago than this doesn't name it:
 * well inside BUNDLE_GC_AGE_MS, so clocks that disagree a bit can't matter.
 */
export const COMMIT_DEADLINE_MS = 30 * 60_000;
/** A transfer with no bytes moving for this long is given up. */
export const STALL_MS = 60_000;
/** Test-only switch: the "cloud" is this folder. */
export const FAKE_STORAGE_ENV = "UNO_GIT_FAKE_STORAGE_DIR";
export const FAKE_STORAGE_DELAY_ENV = "UNO_GIT_FAKE_STORAGE_DELAY_MS";
/** Test-only: faults of the fake storage ("lost-answer", "readback-fail"). */
export const FAKE_FAULTS_ENV = "UNO_GIT_FAKE_FAULTS";
/** Test-only: each fake upload "takes" this many minutes (helperClock). */
export const FAKE_UPLOAD_MINUTES_ENV = "UNO_GIT_FAKE_UPLOAD_MINUTES";
export const DEFAULT_CONSOLE_URL = "https://console.uno4.dev";
/** Where the daemon says its settings.json is (written next to the SDK). */
export const DAEMON_POINTER = ".uno/sdk/daemon.json";

export const NOT_CLOUD = "uno:: remotes work on Uno cloud computers signed in to Uno.";
export const SHALLOW =
  "This copy is shallow (cloned with --depth). Run git fetch --unshallow first.";

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

const logPrefix = (/** @type {string} */ name) => `${GIT_ROOT}${name}/log/`;
export const logKey = (/** @type {string} */ name, /** @type {number} */ seq) =>
  `${logPrefix(name)}${String(seq).padStart(12, "0")}.json`;
const bundlesPrefix = (/** @type {string} */ name) => `${GIT_ROOT}${name}/bundles/`;

/** `2026-10-16T22-13-15-291Z-7886e4`: sorts by time, safe in a key. */
const stamp = (/** @type {number} */ at = Date.now()) =>
  `${new Date(at).toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;

/** When a bundle key's stamp says it was made; null when it doesn't say. */
export function bundleTime(/** @type {string} */ key) {
  const match = /(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z-[0-9a-f]+\.bundle$/.exec(key);
  if (!match) return null;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(at) ? at : null;
}

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

/** https only; plain http only to this computer (a dev console). */
function safeConsoleUrl(/** @type {unknown} */ raw) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol === "https:" || (url.protocol === "http:" && local)) {
      return raw.replace(/\/+$/, "");
    }
  } catch {
    // not a URL
  }
  return null;
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
    return {
      token,
      boxId: Number.isSafeInteger(boxId) && boxId > 0 ? boxId : null,
      consoleUrl: safeConsoleUrl(pointer?.consoleUrl) ?? DEFAULT_CONSOLE_URL,
    };
  }
  return null;
}

// ── Storage: the Drive bucket through the console, or a folder (tests) ──

/**
 * @typedef {{ key: string, size: number, lastModified: number | null }} StoredObject
 * @typedef {{
 *   read(key: string): Promise<Buffer | null>,
 *   download(key: string, file: string): Promise<boolean>,
 *   write(key: string, bytes: Buffer, options?: { ifNoneMatch?: boolean }): Promise<boolean>,
 *   upload(key: string, file: string, size: number): Promise<void>,
 *   list(prefix: string): Promise<{ folders: string[], objects: StoredObject[], truncated: boolean, now: number | null }>,
 *   remove(key: string): Promise<void>,
 *   who: { boxId: number | null, hostname: string },
 * }} Storage
 *   write: false when `ifNoneMatch` and the key already exists (nothing written).
 *   list: `lastModified` and `now` are storage's own clock (ms), null when it doesn't say.
 */

/**
 * This process's clock for deadlines. Tests move it forward (a "slow
 * upload") without waiting.
 */
export const helperClock = { skewMs: 0 };
const now = () => Date.now() + helperClock.skewMs;

/**
 * The storage this process uses: the fake folder in tests, else the Drive.
 * @param {{ home: string, env: NodeJS.ProcessEnv }} where
 * @returns {Storage}
 */
export function openStorage(where) {
  const fake = where.env[FAKE_STORAGE_ENV]?.trim();
  if (fake) {
    const faults = new Set((where.env[FAKE_FAULTS_ENV] ?? "").split(",").filter(Boolean));
    return folderStorage(fake, {
      delayMs: Number(where.env[FAKE_STORAGE_DELAY_ENV]) || 0,
      lostAnswer: faults.has("lost-answer"),
      failReadBack: faults.has("readback-fail"),
      uploadMinutes: Number(where.env[FAKE_UPLOAD_MINUTES_ENV]) || 0,
    });
  }
  const creds = machineCredentials(where);
  if (!creds) throw new UnoGitError(NOT_CLOUD);
  return consoleStorage(creds);
}

/**
 * @typedef {{
 *   delayMs?: number,
 *   lostAnswer?: boolean,
 *   failReadBack?: boolean,
 *   uploadMinutes?: number,
 *   beforeConditionalWrite?: (key: string) => Promise<void>,
 *   truncateAfter?: number,
 *   nowMs?: () => number,
 * }} FakeStorageOptions
 *   delayMs: wait up to this long before each conditional write (races).
 *   lostAnswer: a conditional write lands but answers "exists" (an answer lost, a retry refused).
 *   failReadBack: reading the key just written conditionally fails.
 *   uploadMinutes: each upload moves helperClock this far (a slow upload).
 *   beforeConditionalWrite: runs right before a conditional write (another computer).
 *   truncateAfter: listings stop after this many keys (lowest first), truncated.
 *   nowMs: storage's clock in listings (default: the real one).
 */

/**
 * A folder standing in for the cloud (tests). Conditional writes are atomic
 * (a hard link fails when the name exists), like If-None-Match on storage;
 * the options inject the faults the helper must survive.
 * @param {string} root
 * @param {FakeStorageOptions} [options]
 * @returns {Storage}
 */
export function folderStorage(root, options = {}) {
  const fileOf = (/** @type {string} */ key) => {
    const file = path.resolve(root, key);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new UnoGitError(`Bad key ${key}`);
    return file;
  };
  const place = async (
    /** @type {string} */ key,
    /** @type {(tmp: string) => Promise<void>} */ fill,
    exclusive = false,
  ) => {
    const file = fileOf(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fill(tmp);
    if (!exclusive) {
      await fsp.rename(tmp, file);
      return true;
    }
    try {
      await fsp.link(tmp, file);
      return true;
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error).code === "EEXIST") return false;
      throw error;
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  };
  /** @type {string | null} */
  let justWritten = null;
  return {
    who: { boxId: null, hostname: os.hostname() },
    read: async (key) => {
      if (options.failReadBack && key === justWritten) {
        throw new UnoGitError("Couldn't reach Uno cloud storage.");
      }
      return fsp.readFile(fileOf(key)).catch(() => null);
    },
    download: (key, file) =>
      fsp.copyFile(fileOf(key), file).then(
        () => true,
        () => false,
      ),
    write: async (key, bytes, writeOptions = {}) => {
      if (!writeOptions.ifNoneMatch) {
        return place(key, (tmp) => fsp.writeFile(tmp, bytes));
      }
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * (options.delayMs ?? 0)));
      }
      await options.beforeConditionalWrite?.(key);
      const landed = await place(key, (tmp) => fsp.writeFile(tmp, bytes), true);
      justWritten = key;
      return options.lostAnswer ? false : landed;
    },
    upload: async (key, file) => {
      await place(key, (tmp) => fsp.copyFile(file, tmp));
      helperClock.skewMs += (options.uploadMinutes ?? 0) * 60_000;
    },
    list: async (prefix) => {
      const dir = path.join(root, prefix);
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      const folders = [];
      /** @type {StoredObject[]} */
      const objects = [];
      for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) folders.push(`${prefix}${entry.name}/`);
        else if (!entry.name.endsWith(".tmp")) {
          const stats = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
          if (stats) {
            objects.push({
              key: `${prefix}${entry.name}`,
              size: stats.size,
              lastModified: stats.mtimeMs,
            });
          }
        }
      }
      const limit = options.truncateAfter ?? Infinity;
      return {
        folders,
        objects: objects.slice(0, limit),
        truncated: objects.length > limit,
        now: options.nowMs?.() ?? Date.now(),
      };
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
 * An abort signal that fires after `ms` without a `kick()`.
 * @param {number} ms
 */
function stallGuard(ms) {
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("stalled")), ms);
    timer.unref?.();
  };
  kick();
  return { signal: controller.signal, kick, done: () => clearTimeout(timer) };
}

/** A pass-through that kicks the guard on every chunk. */
const kicking = (/** @type {() => void} */ kick) =>
  new Transform({
    transform(chunk, _encoding, callback) {
      kick();
      callback(null, chunk);
    },
  });

/**
 * The person's Drive bucket through the console (`/api/v1/drive`, bucket
 * presign/objects routes — the ones the daemon's Files use).
 * @param {{ token: string, boxId: number | null, consoleUrl: string }} creds
 * @param {typeof fetch} [fetchImpl]
 * @returns {Storage}
 */
export function consoleStorage(creds, fetchImpl = fetch) {
  /**
   * One console call: its JSON and the console's clock (the Date header).
   * @param {string} route @param {RequestInit} [init]
   */
  const apiWithDate = async (route, init = {}) => {
    let response;
    try {
      response = await fetchImpl(`${creds.consoleUrl}${route}`, {
        ...init,
        headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(STALL_MS),
      });
    } catch {
      throw new UnoGitError("Couldn't reach the Uno console. Check the internet connection.");
    }
    const text = await response.text();
    if (!response.ok) throw new UnoGitError(consoleMessage(response.status, text));
    const date = Date.parse(response.headers.get("date") ?? "");
    try {
      return { json: JSON.parse(text), date: Number.isFinite(date) ? date : null };
    } catch {
      throw new UnoGitError("The Uno console answered something unexpected.");
    }
  };
  /** @param {string} route @param {RequestInit} [init] */
  const api = async (route, init = {}) => (await apiWithDate(route, init)).json;
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
  /**
   * One GET of a stored object, its body through `sink`; false when it doesn't exist.
   * @param {string} key
   * @param {(body: Readable) => Promise<void>} sink
   */
  const get = async (key, sink) => {
    const guard = stallGuard(STALL_MS);
    try {
      const response = await fetchImpl(await getUrl(key), { signal: guard.signal }).catch(
        () => null,
      );
      if (!response) throw new UnoGitError("Couldn't reach Uno cloud storage.");
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new UnoGitError(`Uno cloud storage answered ${response.status} for ${key}.`);
      }
      const body = Readable.fromWeb(/** @type {any} */ (response.body)).pipe(kicking(guard.kick));
      await sink(body).catch((error) => {
        throw guard.signal.aborted
          ? new UnoGitError("Uno cloud storage stopped sending data. Try again.")
          : error;
      });
      return true;
    } finally {
      guard.done();
    }
  };

  /**
   * PUT with retries (network and 5xx only). `make()` gives a fresh body each try.
   * @param {string} url
   * @param {(kick: () => void) => { body: Buffer | ReadableStream, length: number }} make
   * @param {Record<string, string>} [headers]
   * @returns {Promise<number>} -1 on success, else the last status (0 = network)
   */
  const put = async (url, make, headers = {}) => {
    let status = 0;
    for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt += 1) {
      const guard = stallGuard(STALL_MS);
      const { body, length } = make(guard.kick);
      const response = await fetchImpl(url, {
        method: "PUT",
        body: /** @type {any} */ (body),
        headers: { ...headers, "content-length": String(length) },
        signal: guard.signal,
        ...(Buffer.isBuffer(body) ? {} : { duplex: "half" }),
      }).catch(() => null);
      guard.done();
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
   * @param {(start: number, end: number) => (kick: () => void) => { body: Buffer | ReadableStream, length: number }} range
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
    // One part failing stops the other worker too.
    const stopped = { failed: false };
    const worker = async () => {
      while (next <= parts && !stopped.failed) {
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
      await Promise.all(
        Array.from({ length: Math.min(PART_CONCURRENCY, parts) }, () =>
          worker().catch((error) => {
            stopped.failed = true;
            throw error;
          }),
        ),
      );
      await presign({ key, method: "complete", upload_id: uploadId });
    } catch (error) {
      await abort();
      throw error;
    }
  };

  return {
    who: { boxId: creds.boxId, hostname: os.hostname() },
    read: async (key) => {
      /** @type {Buffer[]} */
      const chunks = [];
      const found = await get(key, async (body) => {
        for await (const chunk of body) chunks.push(chunk);
      });
      return found ? Buffer.concat(chunks) : null;
    },
    download: (key, file) => get(key, (body) => pipeline(body, createWriteStream(file))),
    write: async (key, bytes, options = {}) => {
      if (!options.ifNoneMatch) {
        await uploadRange(key, bytes.length, () => () => ({ body: bytes, length: bytes.length }));
        return true;
      }
      // Small and conditional: always one PUT (parts can't be conditional).
      const plan = await presign({ key, method: "put", size: bytes.length });
      if (plan?.multipart === true || typeof plan?.url !== "string") {
        throw new UnoGitError("The Uno console didn't return an upload link.");
      }
      const status = await put(plan.url, () => ({ body: bytes, length: bytes.length }), {
        "if-none-match": "*",
      });
      if (status === -1) return true;
      if (status === 412) return false;
      throw putFailed(status);
    },
    upload: (key, file, size) =>
      uploadRange(key, size, (start, end) => (kick) => ({
        body:
          end <= start
            ? Buffer.alloc(0)
            : /** @type {ReadableStream} */ (
                Readable.toWeb(createReadStream(file, { start, end: end - 1 }).pipe(kicking(kick)))
              ),
        length: end - start,
      })),
    list: async (prefix) => {
      const { json: raw, date } = await apiWithDate(
        `/api/v1/buckets/${await bucketId()}/objects?prefix=${encodeURIComponent(prefix)}`,
      );
      return {
        folders: (Array.isArray(raw?.folders) ? raw.folders : []).filter(
          (/** @type {unknown} */ folder) => typeof folder === "string",
        ),
        objects: (Array.isArray(raw?.objects) ? raw.objects : []).flatMap(
          (/** @type {any} */ object) =>
            typeof object?.key === "string"
              ? [
                  {
                    key: object.key,
                    size: Number(object.size) || 0,
                    lastModified: Number.isFinite(Date.parse(object.last_modified ?? ""))
                      ? Date.parse(object.last_modified)
                      : null,
                  },
                ]
              : [],
        ),
        truncated: raw?.truncated === true,
        now: date,
      };
    },
    remove: async (key) => {
      await api(`/api/v1/buckets/${await bucketId()}/objects?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
    },
  };
}

// ── The remote's state ──────────────────────────────────────────────────

/**
 * @typedef {{ key: string, created: string, size: number, tips: Record<string, string>,
 *   prerequisites: string[] }} BundleEntry
 * @typedef {{ version: 1, seq: number, refs: Record<string, string>, head: string | null,
 *   bundles: BundleEntry[], updatedAt: string | null, rev: string | null,
 *   updatedBy: { boxId: number | null, hostname: string } | null }} RemoteState
 *   seq 0: no log yet (an empty project).
 */

/** @returns {RemoteState} */
export function emptyState() {
  return {
    version: 1,
    seq: 0,
    refs: {},
    head: null,
    bundles: [],
    updatedAt: null,
    rev: null,
    updatedBy: null,
  };
}

const REF_RE = /^refs\/\S+$/;
const ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A state read from the cloud, checked before anything trusts it: refs,
 * ids and bundle keys of this project only.
 * @param {string} name
 * @param {any} raw
 * @param {number} seq
 * @returns {RemoteState}
 */
export function checkState(name, raw, seq) {
  const damaged = (/** @type {string} */ why) =>
    new UnoGitError(`The cloud copy of ${name} looks damaged (${why}); nothing was changed.`);
  if (!raw || typeof raw !== "object") throw damaged("not a state");
  if (raw.version !== 1) {
    throw new UnoGitError(
      `The cloud copy of ${name} was saved by a newer Uno Work. Update Uno Work on this computer.`,
    );
  }
  const refsOk = (/** @type {unknown} */ refs) =>
    !!refs &&
    typeof refs === "object" &&
    Object.entries(refs).every(([ref, id]) => REF_RE.test(ref) && ID_RE.test(String(id)));
  if (!refsOk(raw.refs)) throw damaged("refs");
  if (raw.head !== null && raw.head !== undefined && !REF_RE.test(String(raw.head))) {
    throw damaged("HEAD");
  }
  const bundles = raw.bundles ?? [];
  if (!Array.isArray(bundles)) throw damaged("bundles");
  const prefix = bundlesPrefix(name);
  for (const bundle of bundles) {
    const key = String(bundle?.key ?? "");
    if (
      !key.startsWith(prefix) ||
      !/^[A-Za-z0-9._-]+\.bundle$/.test(key.slice(prefix.length)) ||
      !refsOk(bundle.tips) ||
      !Array.isArray(bundle.prerequisites) ||
      !bundle.prerequisites.every((/** @type {unknown} */ id) => ID_RE.test(String(id))) ||
      !Number.isFinite(Number(bundle.size))
    ) {
      throw damaged("bundle list");
    }
  }
  if (seq > 0 && raw.seq !== seq) throw damaged("log order");
  return {
    ...emptyState(),
    ...raw,
    seq,
    refs: { ...raw.refs },
    head: raw.head ?? null,
    bundles,
  };
}

/** @param {string} name @param {Buffer} bytes @param {number} seq */
function parseState(name, bytes, seq) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new UnoGitError(
      `The cloud copy of ${name} looks damaged (unreadable); nothing was changed.`,
    );
  }
  return checkState(name, parsed, seq);
}

/** Said when storage didn't answer whether our state landed: nothing is deleted. */
export const OUTCOME_UNKNOWN =
  "Couldn't tell whether this push reached your Uno cloud (storage didn't answer). Run git fetch uno, then push again.";

/**
 * Log entries of a project, by seq, and storage's clock. A listing cut
 * short would hide the newest entries (it keeps the lowest keys): refused.
 * @param {Storage} storage
 * @param {string} name
 */
async function logEntries(storage, name) {
  const listing = await storage.list(logPrefix(name));
  if (listing.truncated) {
    throw new UnoGitError(
      `The cloud copy of ${name} has more history entries than can be listed; nothing was changed. Please tell Uno support.`,
    );
  }
  const entries = listing.objects
    .flatMap((object) => {
      const digits = /\/(\d{12})\.json$/.exec(object.key)?.[1];
      return digits === undefined
        ? []
        : [{ seq: Number(digits), lastModified: object.lastModified }];
    })
    .toSorted((a, b) => a.seq - b.seq);
  return { entries, now: listing.now ?? Date.now() };
}

/**
 * The current state: the highest log entry, else an empty project (an
 * empty listing is looked at twice before believing it).
 * @param {Storage} storage
 * @param {string} name
 * @returns {Promise<RemoteState>}
 */
export async function readRemote(storage, name) {
  for (let attempt = 1; ; attempt += 1) {
    const latest = (await logEntries(storage, name)).entries.at(-1)?.seq;
    if (latest === undefined) {
      if (attempt >= 2) return emptyState();
      continue;
    }
    const bytes = await storage.read(logKey(name, latest));
    if (bytes) return parseState(name, bytes, latest);
    // Pruned between the listing and the read: list again.
    if (attempt >= 3) throw new UnoGitError(`Couldn't read the cloud copy of ${name}. Try again.`);
  }
}

/** The `rev` of a log entry; throws OUTCOME_UNKNOWN when it can't be read. */
async function revOf(/** @type {Storage} */ storage, /** @type {string} */ key) {
  /** @type {Buffer | null} */
  let bytes;
  try {
    bytes = await storage.read(key);
  } catch {
    throw new UnoGitError(OUTCOME_UNKNOWN);
  }
  if (bytes === null) return null;
  try {
    return String(JSON.parse(bytes.toString("utf8"))?.rev ?? "");
  } catch {
    return "";
  }
}

/**
 * Write `next` as the state right after `before` — only if no one else did
 * first. Returns what was written when ours is now the current state; null
 * when another computer got there first (ours, if it landed at all, is a
 * stray entry below the newest: readers take the newest, nothing names it).
 * Throws OUTCOME_UNKNOWN when storage can't say; deletes nothing.
 * @param {Storage} storage
 * @param {string} name
 * @param {RemoteState} before
 * @param {Omit<RemoteState, "seq" | "rev" | "updatedAt" | "updatedBy">} next
 */
export async function commitState(storage, name, before, next) {
  // The newest entry must still be `before`: a slow writer must not land in
  // a slot pruning emptied long ago.
  if (((await logEntries(storage, name)).entries.at(-1)?.seq ?? 0) !== before.seq) return null;
  const seq = before.seq + 1;
  const rev = randomBytes(8).toString("hex");
  const state = {
    ...next,
    version: 1,
    seq,
    rev,
    updatedAt: new Date().toISOString(),
    updatedBy: storage.who,
  };
  const key = logKey(name, seq);
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  if (!(await storage.write(key, bytes, { ifNoneMatch: true }))) {
    // Maybe ours after all (an answer lost on the way, a retry refused): look.
    const there = await revOf(storage, key);
    if (there === null) throw new UnoGitError(OUTCOME_UNKNOWN);
    if (there !== rev) return null;
  }
  // Ours landed; it counts only right after `before` (not in a pruned slot).
  if (before.seq > 0 && (await revOf(storage, logKey(name, before.seq))) !== before.rev) {
    return null;
  }
  return { key, bytes };
}

/**
 * Drop log entries more than LOG_KEEP below the newest that are also over
 * an hour old by storage's clock.
 * @param {Storage} storage
 * @param {string} name
 */
export async function pruneLog(storage, name) {
  const { entries, now: storageNow } = await logEntries(storage, name);
  const newest = entries.at(-1)?.seq ?? 0;
  let dropped = 0;
  for (const entry of entries) {
    if (newest - entry.seq <= LOG_KEEP) continue;
    if (entry.lastModified === null || storageNow - entry.lastModified < BUNDLE_GC_AGE_MS) continue;
    await storage.remove(logKey(name, entry.seq));
    dropped += 1;
  }
  return dropped;
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

/** The prerequisites (`-<sha>` lines) of a bundle file's header (read to its end). */
export async function bundlePrerequisites(/** @type {string} */ file) {
  const handle = await fsp.open(file, "r");
  try {
    /** @type {Buffer[]} */
    const chunks = [];
    let position = 0;
    for (;;) {
      const buffer = Buffer.alloc(1 << 16);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (Buffer.concat(chunks).includes("\n\n")) break;
    }
    const text = Buffer.concat(chunks).toString("latin1");
    const end = text.indexOf("\n\n");
    return (end >= 0 ? text.slice(0, end) : text)
      .split("\n")
      .filter((line) => line.startsWith("-"))
      .map((line) => line.slice(1).split(" ")[0] ?? "")
      .filter((id) => ID_RE.test(id));
  } finally {
    await handle.close();
  }
}

// What to undo when the helper is stopped midway (Ctrl-C, a killed git).
/** @type {Set<string>} */
const tempRefs = new Set();
/** @type {Set<string>} */
const tempFiles = new Set();

/** Drop temporary refs and files right now (also from a signal handler). */
export function cleanupNow() {
  for (const file of tempFiles) rmSync(file, { force: true });
  tempFiles.clear();
  if (tempRefs.size > 0) {
    spawnSync("git", ["update-ref", "--stdin"], {
      input: [...tempRefs].map((ref) => `delete ${ref}\n`).join(""),
      stdio: ["pipe", "ignore", "ignore"],
    });
    tempRefs.clear();
  }
}

/** A temp file path, removed by `dropTemp` or `cleanupNow`. */
async function tempFile(/** @type {string} */ dir) {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${stamp()}.bundle`);
  tempFiles.add(file);
  return file;
}

async function dropTemp(/** @type {string} */ file) {
  await fsp.rm(file, { force: true });
  tempFiles.delete(file);
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
  for (const ref of refs) tempRefs.add(ref);
  try {
    const made = await git(["update-ref", "--stdin"], {
      input: refs.map((ref, index) => `update ${ref} ${tips[index]}\n`).join(""),
    });
    if (made.code !== 0) throw new UnoGitError(`git update-ref failed: ${made.stderr.trim()}`);
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
    for (const ref of refs) tempRefs.delete(ref);
  }
}

async function isShallow() {
  return (await git(["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
}

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
  await sweepTmp(tmpDir);
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

  try {
    await answer();
  } finally {
    // Also on a failure: an open stdin would keep this process (and git) waiting.
    lines.close();
  }

  async function answer() {
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
  }
}

/** Leftovers of a helper that was killed: temp files older than an hour. */
async function sweepTmp(/** @type {string} */ dir) {
  const entries = await fsp.readdir(dir).catch(() => []);
  for (const entry of entries) {
    const file = path.join(dir, entry);
    const stats = await fsp.stat(file).catch(() => null);
    if (stats && Date.now() - stats.mtimeMs > 60 * 60_000) await fsp.rm(file, { force: true });
  }
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
    const needed = state.bundles.filter(
      (bundle) => !Object.values(bundle.tips).every((id) => present.has(id)),
    );
    const total = needed.reduce((sum, bundle) => sum + (Number(bundle.size) || 0), 0);
    if (input.progress && needed.length > 0) {
      input.say(`uno: downloading ${input.name} from your Uno cloud (${megabytes(total)})`);
    }
    let vanished = false;
    for (const bundle of needed) {
      if (missing().length === 0) break;
      if (Object.values(bundle.tips).every((id) => present.has(id))) continue;
      const file = await tempFile(input.tmpDir);
      try {
        if (!(await input.storage.download(bundle.key, file))) {
          vanished = true;
          break;
        }
        await gitOk(["bundle", "unbundle", file], "git bundle unbundle");
      } finally {
        await dropTemp(file);
      }
      for (const id of Object.values(bundle.tips)) present.add(id);
    }
    // Packed again by a push from another computer meanwhile: read the new state once.
    if (vanished && attempt === 1) continue;
    const still = await presentObjects(input.wants);
    const lost = input.wants.filter((id) => !still.has(id));
    if (lost.length === 0) return;
    throw new UnoGitError(
      vanished
        ? `The cloud copy of ${input.name} changed while downloading. Try again.`
        : `The cloud copy of ${input.name} is missing ${lost[0]}.`,
    );
  }
}

/** The ref HEAD should name after an update. */
function chooseHead(
  /** @type {Record<string, string>} */ refs,
  /** @type {string | null} */ head,
  /** @type {string | null} */ preferred,
) {
  if (head && refs[head]) return head;
  const heads = Object.keys(refs)
    .filter((ref) => ref.startsWith("refs/heads/"))
    .toSorted();
  if (preferred && heads.includes(preferred)) return preferred;
  return (
    ["refs/heads/main", "refs/heads/master"].find((ref) => heads.includes(ref)) ?? heads[0] ?? null
  );
}

/**
 * What a push may change on top of `before`, and the refs it can't.
 * @param {Array<{ force: boolean, src: string, dst: string }>} specs
 * @param {RemoteState} before
 * @param {boolean} forceAll
 */
async function planUpdates(specs, before, forceAll) {
  /** @type {Map<string, string>} */
  const errors = new Map();
  /** @type {Array<{ dst: string, id: string | null }>} */
  const updates = [];
  for (const spec of specs) {
    const { dst } = spec;
    if (!REF_RE.test(dst)) {
      errors.set(dst, "only full ref names can be pushed");
      continue;
    }
    const old = before.refs[dst] ?? null;
    if (spec.src === "") {
      if (old === null) errors.set(dst, "not found");
      else updates.push({ dst, id: null });
      continue;
    }
    const resolved = await git(["rev-parse", "--verify", "--quiet", spec.src]);
    const id = resolved.stdout.trim();
    if (resolved.code !== 0 || !ID_RE.test(id)) {
      errors.set(dst, `${spec.src} doesn't name a commit here`);
      continue;
    }
    if (old === id) continue;
    if (old !== null && !(spec.force || forceAll)) {
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
  return { errors, updates };
}

/**
 * Push: check each ref, upload one bundle of what the cloud doesn't have,
 * then write the next state with a compare-and-swap; when another computer
 * got there first, re-read and try once more. Returns dst → error text
 * (absent = ok).
 * @param {{ storage: Storage, name: string, specs: Array<{ force: boolean, src: string, dst: string }>,
 *   tmpDir: string, force: boolean, dryRun: boolean, progress: boolean, say: (line: string) => void }} input
 * @returns {Promise<Map<string, string>>}
 */
export async function pushRefs(input) {
  if (await isShallow()) {
    input.say(`uno: ${SHALLOW}`);
    return new Map(
      input.specs.map(({ dst }) => [dst, "shallow copy: run git fetch --unshallow first"]),
    );
  }
  for (let attempt = 1; ; attempt += 1) {
    const before = await readRemote(input.storage, input.name);
    const { errors, updates } = await planUpdates(input.specs, before, input.force);
    if (updates.length === 0 || input.dryRun) return errors;
    const failAll = (/** @type {string} */ why) => {
      for (const update of updates) errors.set(update.dst, why);
      return errors;
    };

    /** @type {BundleEntry | null} */
    let entry = null;
    // One clock reading names the bundle and starts the commit deadline.
    const madeAt = now();
    const tips = [...new Set(updates.flatMap((update) => (update.id ? [update.id] : [])))];
    if (tips.length > 0) {
      const file = await tempFile(input.tmpDir);
      try {
        // Only what `before` names may be left out: the cloud has all of it.
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
          const key = `${bundlesPrefix(input.name)}${stamp(madeAt)}.bundle`;
          const prerequisites = await bundlePrerequisites(file);
          await input.storage.upload(key, file, size);
          entry = {
            key,
            created: new Date(madeAt).toISOString(),
            size,
            tips: Object.fromEntries(updates.flatMap((u) => (u.id ? [[u.dst, u.id]] : []))),
            prerequisites,
          };
        }
      } finally {
        await dropTemp(file);
      }
    }

    const refs = { ...before.refs };
    for (const update of updates) {
      if (update.id === null) delete refs[update.dst];
      else refs[update.dst] = update.id;
    }
    // No refs left: no bundles either (the files go with collectBundles).
    const bundles =
      Object.keys(refs).length === 0 ? [] : [...before.bundles, ...(entry ? [entry] : [])];
    const branch = (await git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() || null;
    const next = { ...before, refs, bundles, head: chooseHead(refs, before.head, branch) };
    // Too late to name the bundle: collectBundles may already treat it as stray.
    if (entry && now() - madeAt > COMMIT_DEADLINE_MS) {
      return failAll("took too long; push again");
    }
    const written = await commitState(input.storage, input.name, before, next);
    if (written) {
      await checkStorageRefusesOverwrites(input, written);
      await housekeeping(input);
      return errors;
    }
    // Another computer saved first. Our bundle stays: collectBundles drops it
    // in an hour unless a state names it after all.
    if (attempt >= 2) return failAll("fetch first");
  }
}

/**
 * Once per repository: the storage must refuse to overwrite an existing log
 * entry (If-None-Match), else two computers pushing at the same moment
 * could lose one push. Writing the same bytes again is harmless either way.
 * @param {{ storage: Storage, tmpDir: string, say: (line: string) => void }} input
 * @param {{ key: string, bytes: Buffer }} written
 */
async function checkStorageRefusesOverwrites(input, written) {
  const marker = path.join(input.tmpDir, "..", "overwrite-check");
  if (await fsp.stat(marker).catch(() => null)) return;
  if (await input.storage.write(written.key, written.bytes, { ifNoneMatch: true })) {
    input.say(
      "uno: warning: this Uno cloud storage doesn't refuse overwrites, so two computers pushing at the same moment could lose one push. Please tell Uno support.",
    );
    return;
  }
  await fsp.mkdir(path.dirname(marker), { recursive: true });
  await fsp.writeFile(marker, `${new Date().toISOString()}\n`);
}

/**
 * After a push, each step on its own (one failing doesn't stop the next):
 * prune the log, pack bundles when due, delete stray bundles.
 * @param {{ storage: Storage, name: string, tmpDir: string, progress: boolean,
 *   say: (line: string) => void }} input
 */
async function housekeeping(input) {
  const steps = [
    () => pruneLog(input.storage, input.name),
    async () => compact({ ...input, state: await readRemote(input.storage, input.name) }),
    () => collectBundles(input.storage, input.name),
  ];
  for (const step of steps) {
    await step().catch((error) =>
      input.say(
        `uno: couldn't tidy ${input.name} in your Uno cloud (${error.message}); it still works.`,
      ),
    );
  }
}

/**
 * Delete bundle files the current state doesn't name, once they are over
 * BUNDLE_GC_AGE_MS old both by the time in their key and by storage's own
 * clock (younger ones may belong to a push in flight). Nothing is deleted
 * when the listing was cut short.
 * @param {Storage} storage
 * @param {string} name
 */
export async function collectBundles(storage, name) {
  const state = await readRemote(storage, name);
  const named = new Set(state.bundles.map((bundle) => bundle.key));
  const listing = await storage.list(bundlesPrefix(name));
  if (listing.truncated) return 0;
  const storageNow = listing.now ?? Date.now();
  let deleted = 0;
  for (const object of listing.objects) {
    const made = bundleTime(object.key);
    if (
      named.has(object.key) ||
      made === null ||
      object.lastModified === null ||
      storageNow - made < BUNDLE_GC_AGE_MS ||
      storageNow - object.lastModified < BUNDLE_GC_AGE_MS
    ) {
      continue;
    }
    await storage.remove(object.key);
    deleted += 1;
  }
  return deleted;
}

/**
 * Many bundles, or bundles much bigger than the last full one: name one
 * full bundle of every ref instead (only when this repository has them
 * all and isn't shallow). Old bundles stay until collectBundles' age rule.
 * @param {{ storage: Storage, name: string, state: RemoteState, tmpDir: string, progress: boolean }} input
 */
export async function compact(input) {
  const { state } = input;
  if (state.bundles.length < 2) return false;
  const full = state.bundles.findLast((bundle) => bundle.prerequisites.length === 0);
  const total = state.bundles.reduce((sum, bundle) => sum + (Number(bundle.size) || 0), 0);
  if (!(state.bundles.length > COMPACT_MAX_BUNDLES || (full && total > 2 * full.size))) {
    return false;
  }
  if (await isShallow()) return false;
  const tips = [...new Set(Object.values(state.refs))];
  if ((await presentObjects(tips)).size !== tips.length) return false;
  const file = await tempFile(input.tmpDir);
  try {
    if (!(await createBundle(file, tips, [], input.progress))) return false;
    const { size } = await fsp.stat(file);
    if (size > MAX_BUNDLE_BYTES) return false;
    const madeAt = now();
    const key = `${bundlesPrefix(input.name)}${stamp(madeAt)}.bundle`;
    await input.storage.upload(key, file, size);
    // Too late to name it (see COMMIT_DEADLINE_MS): left for collectBundles.
    if (now() - madeAt > COMMIT_DEADLINE_MS) return false;
    const packed = {
      key,
      created: new Date(madeAt).toISOString(),
      size,
      tips: { ...state.refs },
      prerequisites: [],
    };
    if (await commitState(input.storage, input.name, state, { ...state, bundles: [packed] })) {
      return true;
    }
    // Another push came first: the full bundle stays for collectBundles.
    return false;
  } finally {
    await dropTemp(file);
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
  /** @type {NodeJS.Signals[]} */
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const stop = () => {
    cleanupNow();
    process.exit(130);
  };
  for (const signal of signals) process.on(signal, stop);
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
    process.stdin.destroy();
  } finally {
    cleanupNow();
    for (const signal of signals) process.off(signal, stop);
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
