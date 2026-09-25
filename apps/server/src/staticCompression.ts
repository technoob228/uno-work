/**
 * Caching and compression for the web app's own files (0.0.85).
 *
 * Until now the daemon served the app with no Cache-Control and no
 * compression: every page load — a reload, a new tab, "Open in a new tab" from
 * Office — downloaded the 5 MB main bundle again (2+ s on a 240 ms link).
 * Vite names everything under `/assets/` by content hash, so those files are
 * immutable; `index.html` and the rest are revalidated.
 *
 * Compressed bodies are kept in memory (the app's text files are a few MB
 * compressed), keyed by path + mtime + size, so each is compressed once per
 * daemon run, on the libuv thread pool.
 */
import { promisify } from "node:util";
import zlib from "node:zlib";

import type { OfficeEngineEncoding } from "./officeEngineAssets.ts";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

export const STATIC_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const STATIC_REVALIDATE_CACHE = "no-cache";

/** Vite's hashed build output: safe to cache forever. */
export function isHashedStaticAsset(pathname: string): boolean {
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(pathname);
}

const COMPRESSIBLE_TYPES =
  /^(text\/|application\/(javascript|json|xml|wasm|manifest\+json)|image\/svg\+xml)/;

export function isStaticCompressible(contentType: string, size: number): boolean {
  return size >= 1024 && COMPRESSIBLE_TYPES.test(contentType);
}

const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const cache = new Map<string, Buffer>();
const inFlight = new Map<string, Promise<Buffer | null>>();
let cachedBytes = 0;

function remember(key: string, body: Buffer): void {
  cache.set(key, body);
  cachedBytes += body.length;
  // Oldest first: Map keeps insertion order.
  for (const [oldKey, oldBody] of cache) {
    if (cachedBytes <= MAX_CACHE_BYTES) break;
    cache.delete(oldKey);
    cachedBytes -= oldBody.length;
  }
}

/** The compressed body, made once per file version; null if compression failed. */
export function compressStaticBody(input: {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly data: Uint8Array;
  readonly encoding: OfficeEngineEncoding;
}): Promise<Buffer | null> {
  const key = `${input.encoding}|${input.filePath}|${input.mtimeMs}|${input.data.length}`;
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency.
    cache.delete(key);
    cache.set(key, hit);
    return Promise.resolve(hit);
  }
  const running = inFlight.get(key);
  if (running) return running;
  const job = (
    input.encoding === "br"
      ? brotli(input.data, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.data.length,
          },
        })
      : gzip(input.data, { level: 6 })
  )
    .then((body) => {
      remember(key, body);
      return body;
    })
    .catch(() => null)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}
