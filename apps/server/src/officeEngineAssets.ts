/**
 * How the daemon serves the office engine package fast (0.0.85).
 *
 * Measured on a 1-vCPU Work machine before this (2026-09-25, Chrome from
 * Buenos Aires, ~240 ms RTT): the first open of a docx took 37 s and every
 * later open 15–20 s, because
 *   - nothing was compressed: 110 MB per open, of which x2t.wasm is 61 MB and
 *     the Word sdk-all.js 28 MB;
 *   - both are bigger than what Chrome's HTTP cache keeps per entry on a
 *     machine with little free disk, so they were downloaded again on every
 *     open ("warm" was not warm);
 *   - the engine's own service worker is an inert stub in this package.
 *
 * What this module does:
 *   1. Versioned URLs `/office-engine/v/<version>/…`. The version is a hash of
 *      the installed package (sizes and mtimes of its key files), so those URLs
 *      are immutable and cached for a year; a reinstall changes the version.
 *      The old unversioned `/office-engine/…` keeps working with a day of cache.
 *   2. Brotli/gzip copies made once per file in the background (libuv thread
 *      pool, not the event loop) and kept next to the engine in
 *      `<engineDir>-compressed/<version>/`. 110 MB → about 17 MB on the wire,
 *      and each cached entry becomes small enough for the HTTP cache.
 *   3. Our own service worker instead of the stub (see
 *      `officeEngineServiceWorkerSource`): cache-first from Cache Storage, which
 *      has no per-entry limit and isn't evicted with the HTTP cache.
 *
 * The engine's files on disk are not modified. The one file answered
 * differently is the (inert) service worker stub — ours is served in its place;
 * like our other changes to ONLYOFFICE it is published (AGPL-3.0, see
 * docs/office-engine.md "Licensing").
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";

import { OFFICE_ENGINE_API_SCRIPT, OFFICE_ENGINE_ROUTE_PREFIX } from "./officeEngine.ts";

export type OfficeEngineEncoding = "br" | "gzip";

/** Response header with the installed engine version (on api.js). */
export const OFFICE_ENGINE_VERSION_HEADER = "x-uno-office-engine-version";

/** Path of the engine's service worker inside the package (the stub we replace). */
export const OFFICE_ENGINE_SERVICE_WORKER = "vendor/document_editor_service_worker.js";

export const OFFICE_ENGINE_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const OFFICE_ENGINE_LEGACY_CACHE = "public, max-age=86400";

/** Files whose size and mtime make up the version: a reinstall changes them. */
const VERSION_FILES = [
  OFFICE_ENGINE_API_SCRIPT,
  "vendor/sdkjs/word/sdk-all-min.js",
  "vendor/sdkjs/cell/sdk-all-min.js",
  "vendor/sdkjs/slide/sdk-all-min.js",
  "vendor/sdkjs/common/wasm/x2t/x2t.wasm",
  "vendor/web-apps/apps/documenteditor/main/app.js",
] as const;

const VERSION_PATTERN = /^[a-f0-9]{12}$/;

/**
 * Splits `/office-engine/v/<version>/rest` into the version and the
 * unversioned pathname (`/office-engine/rest`). Anything else passes through
 * with `version: null`.
 */
export function splitOfficeEngineVersion(pathname: string): {
  readonly version: string | null;
  readonly pathname: string;
} {
  const prefix = `${OFFICE_ENGINE_ROUTE_PREFIX}/v/`;
  if (!pathname.startsWith(prefix)) return { version: null, pathname };
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return { version: null, pathname };
  const version = rest.slice(0, slash);
  if (!VERSION_PATTERN.test(version)) return { version: null, pathname };
  return { version, pathname: `${OFFICE_ENGINE_ROUTE_PREFIX}${rest.slice(slash)}` };
}

let versionMemo: { key: string; version: string | null } | null = null;

/**
 * The installed package's version, or null when the engine isn't installed.
 * Cheap: a handful of `stat`s, memoised on api.js's own stat.
 */
export async function officeEngineVersion(engineDir: string): Promise<string | null> {
  let apiInfo;
  try {
    apiInfo = await fs.stat(nodePath.join(engineDir, OFFICE_ENGINE_API_SCRIPT));
  } catch {
    return null;
  }
  const key = `${engineDir}|${apiInfo.size}|${apiInfo.mtimeMs}|${apiInfo.ino}`;
  if (versionMemo?.key === key) return versionMemo.version;
  const hash = createHash("sha256");
  for (const file of VERSION_FILES) {
    const info = await fs.stat(nodePath.join(engineDir, file)).catch(() => null);
    hash.update(`${file}:${info ? `${info.size}:${Math.trunc(info.mtimeMs)}` : "-"}\n`);
  }
  const version = hash.digest("hex").slice(0, 12);
  versionMemo = { key, version };
  return version;
}

/** Picks the best encoding the browser accepts (br over gzip); `q=0` refuses. */
export function negotiateOfficeEncoding(
  acceptEncoding: string | undefined,
): OfficeEngineEncoding | null {
  if (!acceptEncoding) return null;
  const accepted = new Set<string>();
  for (const part of acceptEncoding.toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    accepted.add(name.trim());
  }
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip")) return "gzip";
  return null;
}

/** Already-compressed formats: compressing them again only costs CPU. */
const INCOMPRESSIBLE = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".zip",
  ".gz",
  ".br",
  ".mp3",
  ".mp4",
  ".docx",
  ".xlsx",
  ".pptx",
  ".pdf",
]);

/** Worth a compressed copy? (Font files have no extension and compress well.) */
export function isOfficeAssetCompressible(filePath: string, size: number): boolean {
  if (size < 1024) return false;
  return !INCOMPRESSIBLE.has(nodePath.extname(filePath).toLowerCase());
}

export function compressedDirFor(engineDir: string, version: string): string {
  return nodePath.join(`${nodePath.resolve(engineDir)}-compressed`, version);
}

const inFlight = new Map<string, Promise<string | null>>();

function compressor(encoding: OfficeEngineEncoding, size: number) {
  return encoding === "br"
    ? zlib.createBrotliCompress({
        params: {
          // q6: x2t.wasm 61 MB → 10.8 MB in ~1 s on a laptop core (q11 is 9.3 MB
          // but takes 100 s).
          [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
        },
      })
    : zlib.createGzip({ level: 6 });
}

/**
 * Path of the compressed copy of `filePath`, making it if needed (once per
 * file and encoding, shared by concurrent requests). Null if it can't be made
 * — the caller serves the file as is.
 */
export function compressedOfficeAsset(input: {
  readonly engineDir: string;
  readonly version: string;
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly encoding: OfficeEngineEncoding;
}): Promise<string | null> {
  const root = nodePath.resolve(input.engineDir);
  const relative = nodePath.relative(root, input.filePath);
  if (relative.startsWith("..") || nodePath.isAbsolute(relative)) return Promise.resolve(null);
  const target = nodePath.join(
    compressedDirFor(root, input.version),
    `${relative}.${input.encoding === "br" ? "br" : "gz"}`,
  );
  const existing = inFlight.get(target);
  if (existing) return existing;
  const job = (async () => {
    const info = await fs.stat(target).catch(() => null);
    if (info?.isFile() && info.mtimeMs >= input.mtimeMs) return target;
    await fs.mkdir(nodePath.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await pipeline(
        createReadStream(input.filePath),
        compressor(input.encoding, input.size),
        createWriteStream(temp),
      );
      await fs.rename(temp, target);
      return target;
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      return null;
    }
  })().finally(() => inFlight.delete(target));
  inFlight.set(target, job);
  return job;
}

/**
 * What an Office open needs first, per editor, biggest first. Compressed in
 * the background after the daemon starts, so even the first open of the day
 * gets the small copies. (Other files are compressed on their first request.)
 */
export const OFFICE_ENGINE_CRITICAL_FILES: ReadonlyArray<string> = [
  "vendor/sdkjs/common/wasm/x2t/x2t.wasm",
  "vendor/sdkjs/word/sdk-all.js",
  "vendor/sdkjs/cell/sdk-all.js",
  "vendor/sdkjs/slide/sdk-all.js",
  "vendor/sdkjs/common/libfont/engine/fonts.wasm",
  "vendor/sdkjs/word/sdk-all-min.js",
  "vendor/sdkjs/cell/sdk-all-min.js",
  "vendor/sdkjs/slide/sdk-all-min.js",
  "vendor/web-apps/apps/documenteditor/main/app.js",
  "vendor/web-apps/apps/spreadsheeteditor/main/app.js",
  "vendor/web-apps/apps/presentationeditor/main/app.js",
  "vendor/sdkjs/common/Charts/ChartStyles.js",
  "vendor/web-apps/apps/documenteditor/main/code.js",
  "vendor/web-apps/apps/presentationeditor/main/code.js",
  "vendor/web-apps/apps/documenteditor/main/resources/css/app.css",
  "vendor/web-apps/apps/spreadsheeteditor/main/resources/css/app.css",
  "vendor/web-apps/apps/presentationeditor/main/resources/css/app.css",
  "vendor/sdkjs/common/AllFonts.js",
  "vendor/sdkjs/common/wasm/x2t/x2t.js",
  "vendor/fonts/049",
];

let warming: Promise<void> | null = null;

/**
 * Makes the compressed copies of the critical files one at a time (so a
 * 1-vCPU machine stays responsive; ~5 s of CPU there, ~28 MB of disk) and
 * drops copies of older versions.
 * Idempotent; never rejects.
 */
export function warmOfficeEngineCompression(
  engineDir: string,
  // Brotli only: every browser sends `br` over HTTPS (how Work machines are
  // reached). gzip copies are made on first request, e.g. for http://localhost.
  encodings: ReadonlyArray<OfficeEngineEncoding> = ["br"],
): Promise<void> {
  if (warming) return warming;
  warming = (async () => {
    const version = await officeEngineVersion(engineDir);
    if (!version) return;
    const parent = nodePath.dirname(compressedDirFor(engineDir, version));
    for (const entry of await fs.readdir(parent).catch(() => [] as string[])) {
      if (entry !== version) {
        await fs.rm(nodePath.join(parent, entry), { recursive: true, force: true });
      }
    }
    for (const encoding of encodings) {
      for (const relative of OFFICE_ENGINE_CRITICAL_FILES) {
        const filePath = nodePath.join(nodePath.resolve(engineDir), relative);
        const info = await fs.stat(filePath).catch(() => null);
        if (!info?.isFile() || !isOfficeAssetCompressible(filePath, info.size)) continue;
        await compressedOfficeAsset({
          engineDir,
          version,
          filePath,
          size: info.size,
          mtimeMs: info.mtimeMs,
          encoding,
        });
      }
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      warming = null;
    });
  return warming;
}

/**
 * The engine's service worker, replacing the inert stub in the package.
 *
 * Scope is the engine's `vendor/` folder of one version, so it never sees the
 * app, the API or anyone's files — only the engine's static code. Cache-first
 * from a cache named after the version; a miss goes to the network and is
 * stored if it's a complete 200. Navigations (the editor's index.html, whose
 * query string changes every time) match without the query. Other versions'
 * caches are dropped on activate.
 */
export function officeEngineServiceWorkerSource(version: string): string {
  return `/* Uno Work: cache for the office engine ${version} (AGPL-3.0, see LICENSE.txt). */
"use strict";
var CACHE = "uno-office-engine-${version}";
var PREFIX = "uno-office-engine-";
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        // Drop the old engine's caches, and whatever the upstream worker left.
        if (key !== CACHE && (key.indexOf(PREFIX) === 0 || key.indexOf("document_editor") !== -1)) {
          return caches.delete(key);
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});
self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf(self.registration.scope.replace(self.location.origin, "")) !== 0) return;
  var navigate = request.mode === "navigate";
  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(request, { ignoreSearch: navigate }).then(function (hit) {
        if (hit) return hit;
        return fetch(request).then(function (response) {
          if (response.ok && response.status === 200 && response.type === "basic") {
            var key = navigate ? url.origin + url.pathname : request;
            cache.put(key, response.clone()).catch(function () {});
          }
          return response;
        });
      });
    }).catch(function () { return fetch(request); })
  );
});
`;
}
