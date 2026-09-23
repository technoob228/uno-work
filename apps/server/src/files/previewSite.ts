/**
 * A web page previewed in Uno Work's right panel (`/api/browser/open` with a
 * `file`, or a click on an .html file) used to be drawn from its text alone,
 * so `assets/style.css`, images and fonts next to it never loaded. Now the
 * panel asks the daemon for a link to the page's **folder**:
 *
 *   POST /api/preview-site {path}          (owner session)  → {url}
 *   GET  /api/preview-site/<token>/<rel>   (no session; the token is the key)
 *
 * The token is random, names exactly one folder, lives a few hours and dies
 * with the daemon. A request can only reach files inside that folder: no
 * `..`, no hidden files or folders (`.env`, `.git`), symlinks resolved and
 * checked to stay inside. Pages are served as they are, sandboxed into an
 * opaque origin (the frame decides whether scripts run), never cached, and
 * without a referrer (the token must not leak to a CDN).
 */
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import nodePath from "node:path";

export const PREVIEW_SITE_TTL_MS = 6 * 60 * 60_000;
const PREVIEW_SITE_MAX_TOKENS = 500;

interface Entry {
  readonly folder: string;
  expiresAt: number;
}

export function makePreviewSiteTokens(now: () => number = Date.now) {
  const byToken = new Map<string, Entry>();
  const byFolder = new Map<string, string>();

  const sweep = () => {
    const at = now();
    for (const [token, entry] of byToken) {
      if (entry.expiresAt <= at) {
        byToken.delete(token);
        if (byFolder.get(entry.folder) === token) byFolder.delete(entry.folder);
      }
    }
    while (byToken.size > PREVIEW_SITE_MAX_TOKENS) {
      const oldest = byToken.keys().next().value;
      if (oldest === undefined) break;
      const entry = byToken.get(oldest);
      byToken.delete(oldest);
      if (entry && byFolder.get(entry.folder) === oldest) byFolder.delete(entry.folder);
    }
  };

  return {
    /** One token per folder; asking again extends it. */
    issue(folder: string): string {
      sweep();
      const existing = byFolder.get(folder);
      if (existing !== undefined) {
        const entry = byToken.get(existing);
        if (entry) {
          entry.expiresAt = now() + PREVIEW_SITE_TTL_MS;
          return existing;
        }
      }
      const token = randomBytes(24).toString("base64url");
      byToken.set(token, { folder, expiresAt: now() + PREVIEW_SITE_TTL_MS });
      byFolder.set(folder, token);
      return token;
    },
    folderOf(token: string): string | null {
      const entry = byToken.get(token);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        byToken.delete(token);
        return null;
      }
      return entry.folder;
    },
  };
}

export type PreviewSiteTokens = ReturnType<typeof makePreviewSiteTokens>;

/** The daemon's one registry (tokens die with the process on purpose). */
export const previewSiteTokens = makePreviewSiteTokens();

export class PreviewSiteError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** `POST`: the page's real folder and its URL under the prefix. */
export async function issuePreviewSite(
  tokens: PreviewSiteTokens,
  filePath: string,
  prefix: string,
): Promise<{ readonly url: string; readonly folder: string }> {
  if (!nodePath.isAbsolute(filePath)) throw new PreviewSiteError(400, "Expected an absolute path.");
  const real = await realpath(filePath).catch(() => null);
  if (real === null) throw new PreviewSiteError(404, "No such file.");
  const info = await stat(real);
  if (!info.isFile()) throw new PreviewSiteError(400, "This is a folder.");
  const folder = nodePath.dirname(real);
  const token = tokens.issue(folder);
  return {
    url: `${prefix}/${token}/${encodeURIComponent(nodePath.basename(real))}`,
    folder,
  };
}

/**
 * `GET <prefix>/<token>/<rest>`: the file inside the token's folder, or null.
 * `rest` is the raw (still URI-encoded) remainder of the path.
 */
export async function resolvePreviewSiteFile(
  tokens: PreviewSiteTokens,
  token: string,
  rest: string,
): Promise<string | null> {
  const folder = tokens.folderOf(token);
  if (folder === null) return null;
  const segments: string[] = [];
  for (const raw of rest.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      return null;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  const candidate = nodePath.join(folder, ...segments);
  const real = await realpath(candidate).catch(() => null);
  if (real === null) return null;
  const root = await realpath(folder).catch(() => null);
  if (root === null || !(real === root || real.startsWith(root + nodePath.sep))) return null;
  const info = await stat(real).catch(() => null);
  return info?.isFile() ? real : null;
}
