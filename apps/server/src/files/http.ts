/**
 * HTTP side of the Files app.
 *
 * - `GET /api/files/raw?path=…[&download=1]` — the owner's bytes of one file
 *   (cookie or bearer session), Range-capable so PDFs and videos stream.
 * - `/s/<token>[/…]` — public share links, no login. A file link shows a card
 *   with preview + Download; a folder link shows a listing, or its
 *   `index.html` as a website. Password-protected links ask first.
 *
 * Shared bytes are served on this machine's own origin, so anything that can
 * run script (HTML, SVG, XML, …) goes out with a `sandbox` CSP: it runs in an
 * opaque origin and can't reach the owner's session or the daemon's API.
 *
 * @module files/http
 */
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import Mime from "@effect/platform-node/Mime";
import { FILES_RAW_ROUTE_PATH, FILES_SHARE_ROUTE_PREFIX } from "@t3tools/contracts";
import { Cause, Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/unstable/http";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import type { FileShareRow } from "../persistence/Services/FileShares.ts";
import { FilesService } from "./FilesService.ts";
import {
  encodeSegment,
  renderFilePage,
  renderFolderPage,
  renderPasswordPage,
  renderUnavailablePage,
  sharePreviewKind,
  TEXT_PREVIEW_MAX_BYTES,
  type ShareListingEntry,
} from "./sharePages.ts";
import {
  decodeShareSubpath,
  isValidSharePasswordProof,
  isWellFormedShareToken,
  resolveShareTarget,
  SharePasswordAttempts,
  sharePasswordCookieName,
  sharePasswordProof,
  shareStatus,
  verifySharePassword,
} from "./shareTokens.ts";

// ── Content types and headers ──────────────────────────────────────────────

/** Types a browser may show inline without being able to run script. */
const INLINE_PASSIVE = [
  /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/,
  /^video\//,
  /^audio\//,
  /^font\//,
  /^application\/pdf$/,
  /^text\/(plain|css|csv|markdown)$/,
  /^application\/(json|javascript|wasm)$/,
];
/** Types that can run script when opened: inline only inside a sandbox. */
const INLINE_SANDBOXED = [/^text\/html$/, /^image\/svg\+xml$/, /^application\/xhtml\+xml$/];

/**
 * Scripts may run (it's somebody's web page) but in an opaque origin: no
 * cookies, no storage of this origin, no same-origin calls to the daemon.
 */
const SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads; frame-ancestors 'self'";
const PAGE_CSP =
  "default-src 'none'; img-src 'self' data:; media-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function contentTypeFor(filePath: string): string {
  const ext = nodePath.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".mjs" || ext === ".js") return "application/javascript";
  return Mime.getType(filePath) ?? "application/octet-stream";
}

export type InlinePolicy = "passive" | "sandboxed" | "attachment";

export function inlinePolicy(contentType: string): InlinePolicy {
  if (INLINE_SANDBOXED.some((pattern) => pattern.test(contentType))) return "sandboxed";
  if (INLINE_PASSIVE.some((pattern) => pattern.test(contentType))) return "passive";
  return "attachment";
}

function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function withCharset(contentType: string): string {
  return contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/javascript"
    ? `${contentType}; charset=utf-8`
    : contentType;
}

export interface ByteRange {
  readonly start: number;
  readonly end: number; // inclusive
}

/**
 * One `bytes=` range (the only kind browsers send for media/PDF). Returns
 * null for "no usable range header" and "unsatisfiable" for a range outside
 * the file.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (!startText && !endText) return null;
  if (!startText) {
    const suffix = Number(endText);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  const end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function serveFile(input: {
  readonly filePath: string;
  readonly size: number;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly download: boolean;
  readonly extraHeaders: Record<string, string>;
}) {
  return Effect.gen(function* () {
    const name = nodePath.basename(input.filePath);
    const contentType = contentTypeFor(input.filePath);
    const policy = input.download ? "attachment" : inlinePolicy(contentType);
    const headers: Record<string, string> = {
      ...input.extraHeaders,
      "accept-ranges": "bytes",
      "content-disposition": contentDisposition(
        policy === "attachment" ? "attachment" : "inline",
        name,
      ),
      "x-content-type-options": "nosniff",
    };
    if (policy === "sandboxed") headers["content-security-policy"] = SANDBOX_CSP;

    const range = parseRangeHeader(input.request.headers["range"], input.size);
    if (range === "unsatisfiable") {
      return HttpServerResponse.empty({
        status: 416,
        headers: { ...headers, "content-range": `bytes */${input.size}` },
      });
    }
    const options = {
      contentType: withCharset(contentType),
      headers: range
        ? { ...headers, "content-range": `bytes ${range.start}-${range.end}/${input.size}` }
        : headers,
      status: range ? 206 : 200,
      ...(range ? { offset: range.start, bytesToRead: range.end - range.start + 1 } : {}),
    };
    return yield* HttpServerResponse.file(input.filePath, options).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Couldn't read the file.", { status: 500 })),
      ),
    );
  });
}

// ── Owner download ─────────────────────────────────────────────────────────

export const filesRawRouteLayer = HttpRouter.add(
  "GET",
  FILES_RAW_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const requested = url.value.searchParams.get("path");
    if (!requested) return HttpServerResponse.text("Missing path", { status: 400 });

    const files = yield* FilesService;
    const resolved = yield* files.resolveOwnerFile(requested).pipe(Effect.result);
    if (resolved._tag === "Failure") {
      return HttpServerResponse.jsonUnsafe({ error: resolved.failure.message }, { status: 404 });
    }
    const stats = yield* Effect.promise(() => fsPromises.stat(resolved.success));
    return yield* serveFile({
      filePath: resolved.success,
      size: stats.size,
      request,
      download: url.value.searchParams.get("download") === "1",
      extraHeaders: { "cache-control": "private, no-store" },
    });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

// ── Public share links ─────────────────────────────────────────────────────

const SHARE_HEADERS: Record<string, string> = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  // Content behind a link is public by design; letting a shared web page's
  // own scripts fetch its sibling files (from the sandbox's opaque origin)
  // needs CORS. No credentials are ever honoured.
  "access-control-allow-origin": "*",
};

function htmlPage(body: string, status = 200, extra: Record<string, string> = {}) {
  return HttpServerResponse.text(body, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: {
      ...SHARE_HEADERS,
      "content-security-policy": PAGE_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...extra,
    },
  });
}

const passwordAttempts = new SharePasswordAttempts();

function shareBase(token: string): string {
  return `${FILES_SHARE_ROUTE_PREFIX}/${token}`;
}

function isSecureRequest(request: HttpServerRequest.HttpServerRequest): boolean {
  return request.headers["x-forwarded-proto"] === "https";
}

async function readTextPreview(filePath: string, size: number): Promise<string | null> {
  if (size > TEXT_PREVIEW_MAX_BYTES) return null;
  try {
    return await fsPromises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function listingEntries(input: {
  readonly directory: string;
  readonly baseHref: string;
}): Promise<ShareListingEntry[]> {
  const dirents = await fsPromises.readdir(input.directory, { withFileTypes: true });
  const entries: ShareListingEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    if (!dirent.isFile() && !dirent.isDirectory()) continue; // symlinks aren't listed
    const stats = await fsPromises.stat(nodePath.join(input.directory, dirent.name));
    const href = `${input.baseHref}${encodeSegment(dirent.name)}${dirent.isDirectory() ? "/" : ""}`;
    entries.push({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      href,
      downloadHref: dirent.isDirectory() ? null : `${href}?download=1`,
    });
  }
  return entries.toSorted((left, right) =>
    left.isDirectory !== right.isDirectory
      ? left.isDirectory
        ? -1
        : 1
      : left.name.localeCompare(right.name, undefined, { numeric: true }),
  );
}

const handleShare = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return htmlPage(renderUnavailablePage("missing"), 400);
  // `/s/<token>[/rest]` — one wildcard route; the token is the first segment.
  const afterPrefix = url.value.pathname.slice(FILES_SHARE_ROUTE_PREFIX.length + 1);
  const slash = afterPrefix.indexOf("/");
  const token = slash === -1 ? afterPrefix : afterPrefix.slice(0, slash);
  if (!isWellFormedShareToken(token)) return htmlPage(renderUnavailablePage("missing"), 404);

  const files = yield* FilesService;
  const share: FileShareRow | null = yield* files
    .findShareByToken(token)
    .pipe(Effect.orElseSucceed(() => null));
  if (share === null) return htmlPage(renderUnavailablePage("missing"), 404);
  const status = shareStatus(share, new Date());
  if (status === "revoked") return htmlPage(renderUnavailablePage("missing"), 404);
  if (status === "expired") return htmlPage(renderUnavailablePage("expired"), 410);

  const base = shareBase(token);
  const pathname = url.value.pathname;
  const remainder = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  const segments = decodeShareSubpath(remainder);
  if (segments === null) return htmlPage(renderUnavailablePage("missing"), 404);
  const shareName = nodePath.basename(share.path);

  // ── Password gate ──
  if (share.passwordHash !== null) {
    const cookieName = sharePasswordCookieName(token);
    if (request.method === "POST") {
      const now = Date.now();
      if (passwordAttempts.isLocked(share.shareId, now)) {
        return htmlPage(
          renderPasswordPage({
            name: shareName,
            actionUrl: pathname,
            error: "Too many wrong tries. Wait a few minutes and try again.",
          }),
          429,
        );
      }
      const body = yield* request.urlParamsBody.pipe(Effect.orElseSucceed(() => UrlParams.empty));
      const password = Option.getOrElse(UrlParams.getFirst(body, "password"), () => "");
      const ok =
        password.length > 0 &&
        (yield* Effect.promise(() => verifySharePassword(password, share.passwordHash!)));
      if (!ok) {
        passwordAttempts.recordFailure(share.shareId, now);
        return htmlPage(
          renderPasswordPage({
            name: shareName,
            actionUrl: pathname,
            error: "That password isn't right.",
          }),
          401,
        );
      }
      passwordAttempts.clear(share.shareId);
      return yield* HttpServerResponse.redirect(pathname + url.value.search, {
        status: 303,
        headers: SHARE_HEADERS,
      }).pipe(
        HttpServerResponse.setCookie(cookieName, sharePasswordProof(token, share.passwordHash), {
          httpOnly: true,
          path: base,
          sameSite: "lax",
          secure: isSecureRequest(request),
          maxAge: "12 hours",
        }),
        Effect.orElseSucceed(() => HttpServerResponse.text("Error", { status: 500 })),
      );
    }
    if (!isValidSharePasswordProof(token, share.passwordHash, request.cookies[cookieName])) {
      return htmlPage(
        renderPasswordPage({ name: shareName, actionUrl: pathname, error: null }),
        401,
      );
    }
  } else if (request.method === "POST") {
    return HttpServerResponse.redirect(pathname, { status: 303, headers: SHARE_HEADERS });
  }

  const download = url.value.searchParams.get("download") === "1";

  // ── One file ──
  if (share.kind === "file") {
    // `/s/<token>` is the card; `/s/<token>/<name>` is the file itself (the
    // name is cosmetic — it gives the browser tab and downloads a real name).
    if (segments.length > 1) return htmlPage(renderUnavailablePage("missing"), 404);
    const target = yield* Effect.promise(() => resolveShareTarget(share, []));
    if (target.kind !== "file") return htmlPage(renderUnavailablePage("gone"), 404);
    // The one name segment must be the file's own name — nothing else resolves.
    if (segments.length === 1 && segments[0] !== nodePath.basename(target.path)) {
      return htmlPage(renderUnavailablePage("missing"), 404);
    }
    const stats = yield* Effect.promise(() => fsPromises.stat(target.path));
    if (segments.length === 1 || download) {
      if (download) yield* files.recordShareAccess(share.shareId);
      return yield* serveFile({
        filePath: target.path,
        size: stats.size,
        request,
        download,
        extraHeaders: SHARE_HEADERS,
      });
    }
    yield* files.recordShareAccess(share.shareId);
    const name = nodePath.basename(target.path);
    const contentType = contentTypeFor(target.path);
    const rawUrl = `${base}/${encodeSegment(name)}`;
    const textPreview =
      sharePreviewKind(contentType, stats.size) === "text"
        ? yield* Effect.promise(() => readTextPreview(target.path, stats.size))
        : null;
    return htmlPage(
      renderFilePage({
        name,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        contentType,
        rawUrl,
        downloadUrl: `${rawUrl}?download=1`,
        textPreview,
        expiresAt: share.expiresAt,
      }),
    );
  }

  // ── A folder: listing, website, or one file inside it ──
  const target = yield* Effect.promise(() => resolveShareTarget(share, segments));
  if (target.kind === "not_found") {
    return htmlPage(renderUnavailablePage(segments.length === 0 ? "gone" : "missing"), 404);
  }
  if (target.kind === "directory") {
    // Relative links in a listing or a site only resolve under a trailing slash.
    if (!pathname.endsWith("/")) {
      return HttpServerResponse.redirect(`${pathname}/${url.value.search}`, {
        status: 302,
        headers: SHARE_HEADERS,
      });
    }
    const indexPath = nodePath.join(target.path, "index.html");
    const index = yield* Effect.promise(() =>
      resolveShareTarget(share, [...segments, "index.html"]),
    );
    if (index.kind === "file" && index.path === indexPath) {
      if (segments.length === 0) yield* files.recordShareAccess(share.shareId);
      const stats = yield* Effect.promise(() => fsPromises.stat(index.path));
      return yield* serveFile({
        filePath: index.path,
        size: stats.size,
        request,
        download: false,
        extraHeaders: SHARE_HEADERS,
      });
    }
    if (segments.length === 0) yield* files.recordShareAccess(share.shareId);
    const entries = yield* Effect.promise(() =>
      listingEntries({ directory: target.path, baseHref: pathname }),
    );
    const crumbs = [{ name: shareName, href: `${base}/` }];
    let href = `${base}/`;
    for (const segment of segments) {
      href += `${encodeSegment(segment)}/`;
      crumbs.push({ name: segment, href });
    }
    return htmlPage(
      renderFolderPage({
        folderName: segments.at(-1) ?? shareName,
        crumbs,
        entries,
        expiresAt: share.expiresAt,
      }),
    );
  }
  if (download) yield* files.recordShareAccess(share.shareId);
  const stats = yield* Effect.promise(() => fsPromises.stat(target.path));
  return yield* serveFile({
    filePath: target.path,
    size: stats.size,
    request,
    download,
    extraHeaders: SHARE_HEADERS,
  });
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("files.share.request.failed", { cause: Cause.pretty(cause) }).pipe(
      Effect.as(htmlPage(renderUnavailablePage("missing"), 500)),
    ),
  ),
);

export const filesShareRouteLayers = [
  HttpRouter.add("GET", `${FILES_SHARE_ROUTE_PREFIX}/*`, handleShare),
  HttpRouter.add("POST", `${FILES_SHARE_ROUTE_PREFIX}/*`, handleShare),
] as const;
