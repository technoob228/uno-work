/**
 * Share-link primitives: token format, lifetime, password hashing and the
 * "already unlocked" cookie proof, and — the security-critical part — mapping
 * a request under `/s/<token>/…` to exactly one file on disk.
 *
 * A file share serves that one file and nothing else. A folder share serves
 * entries under that folder only, never dotfiles or anything inside a
 * dot-folder (`.env`, `.git`, `.ssh`), and re-checks `realpath` so a symlink
 * inside the shared folder can't lead out of it.
 *
 * @module files/shareTokens
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import { isSameOrInside } from "./filesPaths.ts";

/** 24 random bytes → 32 base64url characters (192 bits). */
export const SHARE_TOKEN_BYTES = 24;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function generateShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

export function isWellFormedShareToken(token: string): boolean {
  return SHARE_TOKEN_PATTERN.test(token);
}

export type ShareStatus = "active" | "expired" | "revoked";

export function shareStatus(
  share: { readonly expiresAt: string | null; readonly revokedAt: string | null },
  now: Date,
): ShareStatus {
  if (share.revokedAt !== null) return "revoked";
  if (share.expiresAt !== null && Date.parse(share.expiresAt) <= now.getTime()) return "expired";
  return "active";
}

export function shareExpiresAt(now: Date, expiresInSeconds: number | null | undefined) {
  if (expiresInSeconds === null || expiresInSeconds === undefined) return null;
  return new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
}

// ── Passwords ──────────────────────────────────────────────────────────────

const SCRYPT_KEY_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_BYTES, { N: 16_384, r: 8, p: 1 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** `scrypt$<salt b64url>$<key b64url>` */
export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifySharePassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltText, keyText] = stored.split("$");
  if (scheme !== "scrypt" || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, "base64url");
  const actual = await scryptAsync(password, Buffer.from(saltText, "base64url"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Cookie value proving the visitor typed the password for this link. Derived
 * from the stored hash (a server-side secret), so it can't be forged, and it
 * dies with the link or a password change.
 */
export function sharePasswordProof(token: string, passwordHash: string): string {
  return createHash("sha256").update(`uno-share\n${token}\n${passwordHash}`).digest("base64url");
}

export function isValidSharePasswordProof(
  token: string,
  passwordHash: string,
  candidate: string | undefined,
): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(sharePasswordProof(token, passwordHash));
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Cookie name per link, so unlocking one link unlocks nothing else. */
export function sharePasswordCookieName(token: string): string {
  return `uno_share_${token.slice(0, 12)}`;
}

// ── Mapping a request to a file ────────────────────────────────────────────

export type ShareTarget =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "directory"; readonly path: string; readonly relativePath: string }
  | { readonly kind: "not_found" };

const NOT_FOUND: ShareTarget = { kind: "not_found" };

/**
 * Split the raw URL remainder after `/s/<token>` into decoded segments, or
 * null when it can't be trusted (bad escapes, NUL, `..`, `.`, backslashes,
 * dot-segments of any kind).
 */
export function decodeShareSubpath(rawRemainder: string): string[] | null {
  const trimmed = rawRemainder.replace(/^\/+/, "");
  if (trimmed.length === 0) return [];
  const segments: string[] = [];
  for (const rawSegment of trimmed.split("/")) {
    if (rawSegment.length === 0) continue;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (
      segment.length === 0 ||
      segment.includes("\0") ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.startsWith(".")
    ) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fsPromises.realpath(target);
  } catch {
    return null;
  }
}

/**
 * Resolve what a share may serve for a request.
 *
 * `share.path` is where the link points (kept up to date on rename/move).
 * For a file share, `segments` must be empty — the link addresses one file.
 * For a folder share, `segments` walk down from the folder; the result must
 * stay inside the folder's realpath and never touch a hidden name.
 */
export async function resolveShareTarget(
  share: { readonly path: string; readonly kind: "file" | "folder" },
  segments: ReadonlyArray<string>,
): Promise<ShareTarget> {
  const baseReal = await realpathOrNull(share.path);
  if (baseReal === null) return NOT_FOUND;
  // The link must still point at what it was made for — a file link whose
  // path is now a folder (or the reverse) serves nothing.
  let baseStats;
  try {
    baseStats = await fsPromises.stat(baseReal);
  } catch {
    return NOT_FOUND;
  }

  if (share.kind === "file") {
    if (segments.length > 0 || !baseStats.isFile()) return NOT_FOUND;
    return { kind: "file", path: baseReal };
  }

  if (!baseStats.isDirectory()) return NOT_FOUND;
  for (const segment of segments) {
    if (segment.startsWith(".") || segment.includes("/") || segment.includes("\0")) {
      return NOT_FOUND;
    }
  }
  const lexical = nodePath.resolve(baseReal, ...segments);
  if (!isSameOrInside(lexical, baseReal)) return NOT_FOUND;
  const real = await realpathOrNull(lexical);
  if (real === null || !isSameOrInside(real, baseReal)) return NOT_FOUND;
  // A symlink may land on a hidden name inside the folder: refuse that too.
  const relative = nodePath.relative(baseReal, real);
  if (relative.split(nodePath.sep).some((segment) => segment.startsWith("."))) return NOT_FOUND;

  let stats;
  try {
    stats = await fsPromises.stat(real);
  } catch {
    return NOT_FOUND;
  }
  if (stats.isDirectory()) {
    return { kind: "directory", path: real, relativePath: relative.split(nodePath.sep).join("/") };
  }
  if (stats.isFile()) return { kind: "file", path: real };
  return NOT_FOUND;
}

// ── Failed password attempts ───────────────────────────────────────────────

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_LIMIT = 10;

/** In-memory limiter: at most 10 wrong passwords per link per 15 minutes. */
export class SharePasswordAttempts {
  private readonly failures = new Map<string, { count: number; windowStart: number }>();

  isLocked(shareId: string, now: number): boolean {
    const entry = this.failures.get(shareId);
    if (!entry) return false;
    if (now - entry.windowStart > ATTEMPT_WINDOW_MS) {
      this.failures.delete(shareId);
      return false;
    }
    return entry.count >= ATTEMPT_LIMIT;
  }

  recordFailure(shareId: string, now: number): void {
    const entry = this.failures.get(shareId);
    if (!entry || now - entry.windowStart > ATTEMPT_WINDOW_MS) {
      this.failures.set(shareId, { count: 1, windowStart: now });
      return;
    }
    entry.count += 1;
  }

  clear(shareId: string): void {
    this.failures.delete(shareId);
  }
}
