/**
 * Apps of this computer through Uno Work's own address — the pure half.
 *
 * A Home opened from another device (`https://<label>.uno4.work`) can't load
 * `http://localhost:<port>` (that is the viewer's own machine) nor the public
 * `http://<host>:<port>` of "Show on the internet" (mixed content on an https
 * page, and it puts the app in front of everyone). So Work serves its
 * registered apps itself:
 *
 *   /_apps/<appId>/<token>/<rest>  →  http://127.0.0.1:<manifest port>/<rest>
 *
 * Guards (see `appProxyHttp.ts` for the route):
 *
 * 1. **Opaque origin.** Every proxied response carries
 *    `Content-Security-Policy: sandbox …` without `allow-same-origin`: the
 *    app's pages never run on Work's origin, even opened as a tab — no Work
 *    cookies, storage, DOM or same-origin API calls.
 * 2. **Capability in the path.** An opaque-origin page sends no cookies, so the
 *    route can't check the session. Instead the authenticated UI gets a signed
 *    token (`uno.computer.machineApps`): HMAC-SHA256 over the app id, its port
 *    and an expiry, keyed by a secret derived from the session signing key (a
 *    memory-snapshot clone rotates that key, so clones never share tokens).
 *    Relative URLs inside the app (`api/state`, `./app.js`) resolve under the
 *    token directory and carry it by themselves.
 * 3. **Only registered apps.** The target port is read from the app's manifest
 *    (`~/.uno/apps/<id>.json`) in the daemon's own scan, never from the
 *    request: no loopback-only listeners, no ports below 1024, never the
 *    daemon's own ports (web, App API). The host is always 127.0.0.1.
 * 4. **Headers.** Requests lose hop-by-hop headers and Work's cookies;
 *    responses keep only an allowlist (no Set-Cookie, Clear-Site-Data, HSTS,
 *    reporting endpoints for Work's origin), get `Referrer-Policy: no-referrer`
 *    so the token never leaks to third parties, and redirects back into the
 *    app stay under the prefix.
 */
import type { UnoMachineApp, UnoMachineApps } from "@t3tools/contracts";

import { signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";

export const APP_PROXY_PREFIX = "/_apps";
/** The secret is derived from the session signing key under this purpose. */
export const APP_PROXY_KEY_PURPOSE = "uno-app-proxy-v1";

/**
 * Tokens are minted per hour bucket, so a Home refetching the app list every
 * few seconds keeps the same frame URL (no reload) for an hour; each is valid
 * for 12–13 h — a tab opened with "Open" lasts a working day.
 */
export const APP_PROXY_TOKEN_BUCKET_MS = 60 * 60 * 1000;
export const APP_PROXY_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FUTURE_MS = APP_PROXY_TOKEN_TTL_MS + APP_PROXY_TOKEN_BUCKET_MS + 60 * 1000;

const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOKEN_RE = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/;
const TOKEN_DOMAIN = "uno-app-proxy-token-v1";

/**
 * What the response CSP allows. No `allow-same-origin`: the page gets an
 * opaque origin. No `allow-top-navigation`: it can't navigate Work away.
 */
export const APP_PROXY_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface TokenBinding {
  readonly secret: Uint8Array;
  readonly appId: string;
  readonly port: number;
}

function tokenSignature(input: TokenBinding & { readonly expires: string }): string {
  // NUL can't appear in a validated app id or a number: unambiguous.
  return signPayload(
    [TOKEN_DOMAIN, input.appId, String(input.port), input.expires].join("\u0000"),
    input.secret,
  );
}

/** Expiry of a token minted at `nowMs`: end of the current hour + 12 h. */
export function appProxyTokenExpiry(nowMs: number): number {
  return (
    (Math.floor(nowMs / APP_PROXY_TOKEN_BUCKET_MS) + 1) * APP_PROXY_TOKEN_BUCKET_MS +
    APP_PROXY_TOKEN_TTL_MS
  );
}

export function signAppProxyToken(input: TokenBinding & { readonly nowMs: number }): string {
  const expires = appProxyTokenExpiry(input.nowMs).toString(36);
  return `${expires}.${tokenSignature({ ...input, expires })}`;
}

/**
 * True for a token this daemon minted for exactly this app and port that has
 * not expired. Forged, foreign (other app, other port, other key) and
 * malformed tokens are all just false; the comparison is constant-time.
 */
export function verifyAppProxyToken(
  input: TokenBinding & { readonly token: string; readonly nowMs: number },
): boolean {
  const match = TOKEN_RE.exec(input.token);
  if (match === null) return false;
  const [, expires, signature] = match as unknown as [string, string, string];
  const expected = tokenSignature({ ...input, expires });
  if (!timingSafeEqualBase64Url(signature, expected)) return false;
  const expiresMs = Number.parseInt(expires, 36);
  if (!Number.isSafeInteger(expiresMs)) return false;
  return input.nowMs <= expiresMs && expiresMs - input.nowMs <= MAX_FUTURE_MS;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** A request for the proxy (`/_apps/…`, as received, query included). */
export function isAppProxyRequestTarget(target: string): boolean {
  return target.startsWith(`${APP_PROXY_PREFIX}/`);
}

/**
 * The daemon's own loopback address of a proxied page (`https://x.uno4.work/_apps/…`
 * → `http://127.0.0.1:<web port>/_apps/…`), for checks the daemon makes
 * itself; undefined for any other address.
 */
export function appProxyLoopbackUrl(url: string, webPort: number): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (!isAppProxyRequestTarget(parsed.pathname)) return undefined;
  return `http://127.0.0.1:${webPort}${parsed.pathname}${parsed.search}`;
}

/** `/_apps/<appId>/<token>/` — what the UI resolves against Work's address. */
export function appProxyPath(appId: string, token: string): string {
  return `${APP_PROXY_PREFIX}/${appId}/${token}/`;
}

export type AppProxyRequestPath =
  | {
      readonly kind: "ok";
      readonly appId: string;
      readonly token: string;
      /** Path for the app, starting with `/`, still percent-encoded. */
      readonly upstreamPath: string;
    }
  /** `/_apps/<id>/<token>` without the slash: relative URLs need it. */
  | { readonly kind: "add-slash"; readonly location: string }
  | { readonly kind: "invalid" };

const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Splits `/_apps/<appId>/<token>/<rest>` (pathname as received, plus its
 * query). `rest` is forwarded byte for byte, but refused when any segment is
 * (or decodes to) `.`/`..`, holds a slash, backslash or NUL in encoded form —
 * the app must see exactly the path the browser resolved, and nothing that a
 * naive app could turn into a file outside its folder.
 */
export function parseAppProxyPath(pathname: string, search = ""): AppProxyRequestPath {
  if (!pathname.startsWith(`${APP_PROXY_PREFIX}/`)) return { kind: "invalid" };
  const parts = pathname.slice(APP_PROXY_PREFIX.length + 1).split("/");
  const [appId, token, ...rest] = parts;
  if (appId === undefined || token === undefined) return { kind: "invalid" };
  if (!APP_ID_RE.test(appId) || !TOKEN_RE.test(token)) return { kind: "invalid" };
  if (rest.length === 0) {
    return { kind: "add-slash", location: `${appProxyPath(appId, token)}${search}` };
  }
  if (pathname.includes("\\")) return { kind: "invalid" };
  for (const segment of rest) {
    if (DOT_SEGMENT.test(segment)) return { kind: "invalid" };
    const decoded = decodeSegment(segment);
    if (decoded === null) return { kind: "invalid" };
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\u0000")
    ) {
      return { kind: "invalid" };
    }
  }
  return { kind: "ok", appId, token, upstreamPath: `/${rest.join("/")}${search}` };
}

// ---------------------------------------------------------------------------
// Which apps
// ---------------------------------------------------------------------------

/** The part of a scanned / listed app the proxy decides on. */
export interface AppProxyCandidate {
  readonly id: string;
  readonly source: string;
  readonly port: number | null;
  readonly loopbackOnly: boolean;
  readonly telegramBot?: unknown;
}

/** Ports below this are the machine's own services (ssh, the web port, …). */
const MIN_APP_PORT = 1024;

/**
 * Why this app can't go through the proxy, or null when it can. Only a
 * registered app (`~/.uno/apps/<id>.json`) with a TCP port of its own: not a
 * port the scan merely found, not a listener on 127.0.0.1 only (someone kept
 * it private on purpose), never one of the daemon's own ports.
 */
export function appProxyRefusal(
  app: AppProxyCandidate,
  daemonPorts: ReadonlySet<number>,
): string | null {
  if (app.source !== "manifest") return "not a registered app";
  if (!APP_ID_RE.test(manifestIdOf(app.id) ?? "")) return "not a registered app";
  if (app.telegramBot !== undefined && app.telegramBot !== null) return "a Telegram bot";
  if (app.port === null) return "no port";
  if (!Number.isInteger(app.port) || app.port < MIN_APP_PORT || app.port > 65_535) {
    return "a system port";
  }
  if (daemonPorts.has(app.port)) return "Uno Work's own port";
  if (app.loopbackOnly) return "listens on 127.0.0.1 only";
  return null;
}

/**
 * The app list as the UI gets it: every running web app the proxy may serve
 * carries `proxyPath` with a fresh token. Only the authenticated UI's RPC
 * adds it — agents' tools and the console never see the tokens.
 */
export function withAppProxyPaths(
  list: UnoMachineApps,
  input: {
    readonly secret: Uint8Array;
    readonly daemonPorts: ReadonlySet<number>;
    readonly nowMs: number;
  },
): UnoMachineApps {
  return {
    ...list,
    apps: list.apps.map((app) => {
      const proxyPath = appProxyPathFor(app, input);
      return proxyPath === null ? app : { ...app, proxyPath };
    }),
  };
}

function appProxyPathFor(
  app: UnoMachineApp,
  input: {
    readonly secret: Uint8Array;
    readonly daemonPorts: ReadonlySet<number>;
    readonly nowMs: number;
  },
): string | null {
  if (app.status !== "running" || !app.http || app.port === null) return null;
  if (appProxyRefusal(app, input.daemonPorts) !== null) return null;
  const appId = manifestIdOf(app.id);
  if (appId === null) return null;
  const token = signAppProxyToken({
    secret: input.secret,
    appId,
    port: app.port,
    nowMs: input.nowMs,
  });
  return appProxyPath(appId, token);
}

/** `manifest:notes` → `notes`; anything else → null. */
export function manifestIdOf(id: string): string | null {
  return id.startsWith("manifest:") ? id.slice("manifest:".length) : null;
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);

/** Never forwarded to the app: Work's cookies, and what only the proxy decides. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "content-length",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-prefix",
  "x-real-ip",
]);

type HeaderValue = string | ReadonlyArray<string> | undefined;

function headerList(value: HeaderValue): string[] {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

/** Header names a `Connection: a, b` header marks as hop-by-hop. */
function connectionTokens(headers: Readonly<Record<string, HeaderValue>>): Set<string> {
  const tokens = new Set<string>();
  for (const value of headerList(headers["connection"])) {
    for (const token of value.split(",")) {
      const name = token.trim().toLowerCase();
      if (name) tokens.add(name);
    }
  }
  return tokens;
}

/**
 * The request headers the app gets: the browser's, minus hop-by-hop ones and
 * Work's cookies, with Host pinned to the app's own loopback address and the
 * usual X-Forwarded-* so an app can build absolute links if it must.
 */
export function appProxyRequestHeaders(input: {
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly port: number;
  readonly prefix: string;
  readonly publicHost: string | null;
  readonly publicProto: "http" | "https";
}): Record<string, string> {
  const dropped = connectionTokens(input.headers);
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input.headers)) {
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || dropped.has(name) || DROPPED_REQUEST_HEADERS.has(name)) continue;
    const values = headerList(value);
    if (values.length === 0) continue;
    out[name] = values.join(", ");
  }
  out["host"] = `127.0.0.1:${input.port}`;
  out["x-forwarded-proto"] = input.publicProto;
  out["x-forwarded-prefix"] = input.prefix.replace(/\/+$/, "");
  if (input.publicHost) out["x-forwarded-host"] = input.publicHost;
  return out;
}

/**
 * Response headers that may pass from the app. Everything else is dropped:
 * Set-Cookie (would land on Work's domain), Clear-Site-Data (could sign the
 * person out of Work), Strict-Transport-Security, NEL / Report-To /
 * Reporting-Endpoints, Service-Worker-Allowed, Access-Control-* (the proxy
 * sets its own), WWW-Authenticate (a Basic prompt on Work's origin) and any
 * custom header (an opaque-origin page can't read those anyway).
 */
const PASSED_RESPONSE_HEADERS = new Set([
  "accept-ranges",
  "age",
  "cache-control",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-length",
  "content-range",
  "content-security-policy",
  "content-type",
  "date",
  "etag",
  "expires",
  "last-modified",
  "pragma",
  "retry-after",
  "vary",
  "x-content-type-options",
  "x-frame-options",
]);

/**
 * The headers Work answers with: the allowlist above, Location kept inside the
 * app, `Cache-Control` made private (a CDN in front of Work must not keep the
 * app's pages), plus the sandbox CSP, no-referrer and CORS for the page's own
 * opaque origin (its `fetch("api/…")` to this URL is cross-origin).
 */
export function appProxyResponseHeaders(input: {
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly port: number;
  readonly prefix: string;
}): Record<string, string> {
  const dropped = connectionTokens(input.headers);
  const out: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input.headers)) {
    const name = rawName.toLowerCase();
    if (!PASSED_RESPONSE_HEADERS.has(name) || HOP_BY_HOP.has(name) || dropped.has(name)) continue;
    const values = headerList(value);
    if (values.length === 0) continue;
    // Several CSP headers are each enforced; joined with "," they still are.
    out[name] = values.join(", ");
  }
  const location = headerList(input.headers["location"])[0];
  if (location !== undefined) {
    out["location"] = rewriteAppLocation(location, input.port, input.prefix);
  }
  out["cache-control"] = privateCacheControl(out["cache-control"]);
  out["content-security-policy"] = out["content-security-policy"]
    ? `${APP_PROXY_CSP}, ${out["content-security-policy"]}`
    : APP_PROXY_CSP;
  out["referrer-policy"] = "no-referrer";
  out["access-control-allow-origin"] = "*";
  out["x-robots-tag"] = "noindex, nofollow";
  return out;
}

/**
 * A redirect back into the app stays under the prefix: `/login` and
 * `http://127.0.0.1:<port>/login` (or localhost) become
 * `<prefix>login`. Any other address is left alone.
 */
export function rewriteAppLocation(location: string, port: number, prefix: string): string {
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  if (location.startsWith("/") && !location.startsWith("//") && !location.startsWith("/\\")) {
    return `${base}${location.slice(1)}`;
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
  const samePort = (url.port || (url.protocol === "https:" ? "443" : "80")) === String(port);
  if (url.protocol === "http:" && loopback && samePort) {
    return `${base}${url.pathname.slice(1)}${url.search}${url.hash}`;
  }
  return location;
}

/** `public, max-age=60` → `private, max-age=60`; none → `private, no-cache`. */
export function privateCacheControl(value: string | undefined): string {
  if (!value) return "private, no-cache";
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !/^(public|private|s-maxage=.*)$/i.test(part));
  if (parts.some((part) => /^no-store$/i.test(part))) return parts.join(", ");
  return ["private", ...parts].join(", ");
}

/** Preflight answer for the page's own cross-origin requests (opaque origin). */
export function appProxyPreflightHeaders(
  headers: Readonly<Record<string, HeaderValue>>,
): Record<string, string> {
  const method = headerList(headers["access-control-request-method"])[0];
  const requested = headerList(headers["access-control-request-headers"])[0];
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": method && /^[A-Z]{1,16}$/.test(method) ? method : "GET",
    ...(requested && /^[A-Za-z0-9\-_, ]{1,512}$/.test(requested)
      ? { "access-control-allow-headers": requested }
      : {}),
    "access-control-max-age": "600",
    "cache-control": "no-store",
    "content-security-policy": APP_PROXY_CSP,
  };
}
