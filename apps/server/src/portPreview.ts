/**
 * "Your site" in the person's own browser (18.10, contract
 * reports/day_2026-10-18/local-preview/CONTRACT.md): the console sends a
 * request for `https://p{PORT}--{LABEL}.uno4.work/...` to this daemon with
 * `X-Uno-Port-Preview: PORT`, and the daemon hands it to the program
 * listening on `127.0.0.1:PORT` (or `[::1]:PORT`) — vite, next, anything —
 * as if the browser were on the computer at `http://localhost:PORT`:
 *
 *   - our session cookie never reaches the program, the page's own
 *     `Authorization` comes back from `X-Uno-App-Authorization`, `X-Uno-*`
 *     and `X-Forwarded-*` are dropped, `Host`/`Origin`/`Referer` read
 *     `localhost:PORT` (vite's allowedHosts, a dev server's WebSocket Origin
 *     check, Next's server actions);
 *   - a redirect to `http://localhost:PORT/x` goes to the port's address;
 *     `X-Frame-Options` is dropped and so is an HTML page's CSP (the panel
 *     frames it and puts Comment's script in — the owner's dev preview);
 *   - an HTML page gets `<script src="/__uno/page-tools.js">` first in its
 *     <head> (asked for uncompressed; a compressed answer is unpacked);
 *   - WebSocket upgrades (HMR) are piped through as they are;
 *   - nothing listening → 502 "Nothing is running on port N".
 *
 * Plain Node (`node:http`): production daemons run on Node (deploy/install.sh).
 * Who may come here is decided before (portPreviewHttp.ts).
 */
import * as Http from "node:http";
import * as Net from "node:net";
import { pipeline, Transform, type TransformCallback } from "node:stream";
import * as Zlib from "node:zlib";

import {
  PORT_PREVIEW_APP_AUTHORIZATION_HEADER,
  PORT_PREVIEW_PAGE_TOOLS_PATH,
} from "@t3tools/shared/portPreview";
import { buildPageToolsScript } from "@t3tools/shared/pageToolsScript";

export const PAGE_TOOLS_SCRIPT_TAG = `<script src="${PORT_PREVIEW_PAGE_TOOLS_PATH}" data-uno-page-tools></script>`;

/** How long to wait for the program to accept the connection. */
const CONNECT_TIMEOUT_MS = 5_000;
/** How much of an HTML page to hold while looking for its <head>. */
const INJECT_SCAN_LIMIT = 64 * 1024;

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
]);

export interface PortPreviewTarget {
  readonly port: number;
  /** The port's public host (`p5173--abc.uno4.work`) — from `X-Forwarded-Host`. */
  readonly publicHost: string | null;
  /** The daemon's session cookie: never handed to the program. */
  readonly sessionCookieName: string;
}

/** The port's public host as the console forwarded it. */
export function portPreviewPublicHost(headers: Http.IncomingHttpHeaders): string | null {
  const raw = headers["x-forwarded-host"] ?? headers.host;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const host = value?.split(",")[0]?.trim();
  return host ? host : null;
}

function headerValue(value: string | ReadonlyArray<string> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.join(", ");
}

/** The `Cookie` header without our session cookie (null — nothing left). */
export function stripSessionCookie(cookie: string | undefined, sessionCookieName: string) {
  if (!cookie) return null;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const name = part.split("=", 1)[0]!.trim();
      return name !== sessionCookieName;
    });
  return kept.length > 0 ? kept.join("; ") : null;
}

function rewriteToLocal(value: string, publicHost: string | null, port: number): string {
  if (!publicHost) return value;
  try {
    const url = new URL(value);
    if (url.host.toLowerCase() !== publicHost.toLowerCase()) return value;
    if (value === url.origin) return `http://localhost:${port}`;
    return `http://localhost:${port}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

/** A navigation (a page, not a script or a fetch): asked for uncompressed, to put the script in. */
export function isNavigationRequest(headers: Http.IncomingHttpHeaders): boolean {
  const dest = headers["sec-fetch-dest"];
  if (dest === "document" || dest === "iframe") return true;
  if (dest !== undefined && dest !== "") return false;
  return (headers.accept ?? "").includes("text/html");
}

/** The headers the program gets. `upgrade`: keep the WebSocket handshake ones. */
export function portPreviewRequestHeaders(
  headers: Http.IncomingHttpHeaders,
  target: PortPreviewTarget,
  options: { readonly upgrade: boolean },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    const value = headerValue(rawValue);
    if (value === undefined) continue;
    if (name.startsWith("x-uno-") || name.startsWith("x-forwarded-")) continue;
    if (name === "forwarded" || name === "x-real-ip") continue;
    if (name === "host" || name === "cookie" || name === "authorization") continue;
    if (!options.upgrade && HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  out["host"] = `localhost:${target.port}`;
  const cookie = stripSessionCookie(headerValue(headers.cookie), target.sessionCookieName);
  if (cookie) out["cookie"] = cookie;
  const appAuthorization = headerValue(headers[PORT_PREVIEW_APP_AUTHORIZATION_HEADER]);
  if (appAuthorization) out["authorization"] = appAuthorization;
  if (out["origin"]) out["origin"] = rewriteToLocal(out["origin"], target.publicHost, target.port);
  if (out["referer"])
    out["referer"] = rewriteToLocal(out["referer"], target.publicHost, target.port);
  if (!options.upgrade && isNavigationRequest(headers)) out["accept-encoding"] = "identity";
  return out;
}

/** A redirect to the program's own address goes to the port's public address instead. */
export function rewritePortPreviewLocation(
  location: string,
  target: Pick<PortPreviewTarget, "port" | "publicHost">,
): string {
  if (!target.publicHost) return location;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location; // relative: already right
  }
  const host = url.hostname.toLowerCase();
  const local =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!local || port !== target.port) return location;
  return `https://${target.publicHost}${url.pathname}${url.search}${url.hash}`;
}

function isHtml(contentType: string | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("text/html");
}

/** The headers the browser gets back. */
export function portPreviewResponseHeaders(
  headers: Http.IncomingHttpHeaders,
  target: Pick<PortPreviewTarget, "port" | "publicHost">,
  options: { readonly injecting: boolean },
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const html = isHtml(headerValue(headers["content-type"]));
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (name === "x-frame-options") continue;
    if (
      html &&
      (name === "content-security-policy" || name === "content-security-policy-report-only")
    ) {
      continue;
    }
    if (options.injecting && (name === "content-length" || name === "content-encoding")) continue;
    if (name === "location" && typeof value === "string") {
      out[name] = rewritePortPreviewLocation(value, target);
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Where the script goes: right after `<head …>`, else after `<html …>`, else after the doctype. */
export function pageToolsInsertIndex(prefix: Buffer, complete: boolean): number | null {
  const text = prefix.toString("latin1");
  const head = /<head(?:\s[^>]*)?>/i.exec(text);
  if (head) return head.index + head[0].length;
  const pastHead = /<body[\s>]/i.test(text);
  if (!complete && !pastHead && prefix.length < INJECT_SCAN_LIMIT) return null;
  const html = /<html(?:\s[^>]*)?>/i.exec(text);
  if (html) return html.index + html[0].length;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
  if (doctype) return doctype[0].length;
  const firstTag = text.search(/</);
  return firstTag < 0 ? 0 : firstTag;
}

/** Puts {@link PAGE_TOOLS_SCRIPT_TAG} into an HTML stream, as early as it can. */
export class PageToolsInjector extends Transform {
  private held: Buffer[] = [];
  private heldLength = 0;
  private done = false;

  private flushWith(index: number | null): void {
    const all = Buffer.concat(this.held, this.heldLength);
    this.held = [];
    this.heldLength = 0;
    this.done = true;
    const at = index ?? 0;
    this.push(all.subarray(0, at));
    this.push(Buffer.from(PAGE_TOOLS_SCRIPT_TAG, "latin1"));
    this.push(all.subarray(at));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (this.done) {
      callback(null, chunk);
      return;
    }
    this.held.push(chunk);
    this.heldLength += chunk.length;
    const index = pageToolsInsertIndex(Buffer.concat(this.held, this.heldLength), false);
    if (index !== null) this.flushWith(index);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    if (!this.done) {
      const all = Buffer.concat(this.held, this.heldLength);
      this.flushWith(pageToolsInsertIndex(all, true));
    }
    callback();
  }
}

/** Unpacks what the program compressed anyway (it ignored `identity`); null — leave it. */
function decoderFor(encoding: string | undefined): Transform | null {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return Zlib.createGunzip();
    case "deflate":
      return Zlib.createInflate();
    case "br":
      return Zlib.createBrotliDecompress();
    default:
      return null;
  }
}

/** The 502 page: an honest sentence, not a browser error. */
export function nothingListeningPage(port: number): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nothing on port ${port}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="font:15px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;` +
    `color:#444;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px;text-align:center">` +
    `<div><h2 style="font-weight:600;margin:0 0 8px;color:#222">Nothing is running on port ${port} on this computer yet</h2>` +
    `<p style="margin:0">Start the app (or ask the agent to), then reload this page.</p></div></body></html>`
  );
}

function isRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ECONNREFUSED" || code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT";
}

function connectOnce(host: string, port: number): Promise<Net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = Net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`connect ${host}:${port} timed out`), { code: "ETIMEDOUT" }));
    }, CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** A connection to the program: IPv4 loopback first, then IPv6 (vite on a `localhost` that resolves to ::1). */
export async function connectToLocalPort(port: number): Promise<Net.Socket | null> {
  try {
    return await connectOnce("127.0.0.1", port);
  } catch (error) {
    if (!isRefused(error)) throw error;
  }
  try {
    return await connectOnce("::1", port);
  } catch (error) {
    if (isRefused(error)) return null;
    throw error;
  }
}

function sendPlain(
  res: Http.ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(res.req?.method === "HEAD" ? undefined : body);
}

/** The page script on the port's address (postMessage channel; it waits for the host's nonce). */
export function servePageToolsScript(req: Http.IncomingMessage, res: Http.ServerResponse): void {
  req.resume();
  const body = buildPageToolsScript("", "postMessage");
  res.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "no-cache",
    "content-length": Buffer.byteLength(body),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/**
 * Relay one HTTP request to the program. Resolves when the answer is fully
 * written (or the browser went away); never rejects.
 */
export function relayPortPreviewRequest(
  req: Http.IncomingMessage,
  res: Http.ServerResponse,
  target: PortPreviewTarget,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    res.once("close", finish);
    res.once("finish", finish);

    void connectToLocalPort(target.port).then(
      (socket) => {
        if (!socket) {
          req.resume();
          sendPlain(res, 502, nothingListeningPage(target.port), "text/html; charset=utf-8");
          return;
        }
        if (res.destroyed) {
          socket.destroy();
          return;
        }
        // No `agent`: with one (even `false`) Node ignores createConnection.
        const upstream = Http.request({
          createConnection: () => socket,
          method: req.method,
          path: req.url ?? "/",
          headers: portPreviewRequestHeaders(req.headers, target, { upgrade: false }),
        });
        res.once("close", () => {
          if (!res.writableFinished) upstream.destroy();
        });
        upstream.once("response", (answer) => {
          const status = answer.statusCode ?? 502;
          const bodyless =
            req.method === "HEAD" || status === 204 || status === 304 || status < 200;
          const html = isHtml(headerValue(answer.headers["content-type"]));
          const decoder =
            html && !bodyless ? decoderFor(headerValue(answer.headers["content-encoding"])) : null;
          const encoded =
            (headerValue(answer.headers["content-encoding"]) ?? "identity") !== "identity";
          const injecting = html && !bodyless && (!encoded || decoder !== null);
          const headers = portPreviewResponseHeaders(answer.headers, target, { injecting });
          res.writeHead(status, answer.statusMessage, headers);
          if (bodyless) {
            answer.resume();
            res.end();
            return;
          }
          const onError = () => res.destroy();
          if (injecting && decoder) {
            pipeline(answer, decoder, new PageToolsInjector(), res, (error) => {
              if (error) onError();
            });
          } else if (injecting) {
            pipeline(answer, new PageToolsInjector(), res, (error) => {
              if (error) onError();
            });
          } else {
            pipeline(answer, res, (error) => {
              if (error) onError();
            });
          }
        });
        upstream.once("error", () => {
          if (!res.headersSent) {
            sendPlain(res, 502, nothingListeningPage(target.port), "text/html; charset=utf-8");
          } else {
            res.destroy();
          }
        });
        // `pipe`, not `pipeline`: an upstream error must not tear the
        // browser's socket down before the 502 is written.
        req.pipe(upstream);
      },
      () => {
        req.resume();
        sendPlain(res, 502, nothingListeningPage(target.port), "text/html; charset=utf-8");
      },
    );
  });
}

function rawResponse(status: number, reason: string, body: string): string {
  return (
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n\r\n" +
    body
  );
}

/**
 * Relay a WebSocket upgrade (HMR): the handshake goes to the program with the
 * same header rules, then both directions are piped as bytes — the program's
 * 101 (or refusal) goes back untouched. Resolves when the browser's socket
 * closes.
 */
export function relayPortPreviewUpgrade(
  req: Http.IncomingMessage,
  socket: Net.Socket,
  head: Buffer,
  target: PortPreviewTarget,
): Promise<void> {
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
    socket.on("error", () => socket.destroy());
    void connectToLocalPort(target.port).then(
      (upstream) => {
        if (!upstream) {
          socket.end(rawResponse(502, "Bad Gateway", `Nothing is running on port ${target.port}`));
          return;
        }
        if (socket.destroyed) {
          upstream.destroy();
          return;
        }
        const headers = portPreviewRequestHeaders(req.headers, target, { upgrade: true });
        let handshake = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\n`;
        for (const [name, value] of Object.entries(headers)) handshake += `${name}: ${value}\r\n`;
        handshake += "\r\n";
        upstream.write(handshake);
        if (head.length > 0) upstream.write(head);
        upstream.on("error", () => socket.destroy());
        upstream.once("close", () => socket.destroy());
        socket.once("close", () => upstream.destroy());
        upstream.pipe(socket);
        socket.pipe(upstream);
      },
      () => socket.end(rawResponse(502, "Bad Gateway", `Port ${target.port} is unreachable`)),
    );
  });
}
