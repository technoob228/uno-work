/**
 * A tiny stand-in for the console's Work proxy in "one window" mode
 * (fishcode `back/internal/api/work_ui.go` + `work_proxy.go`).
 *
 * The account address serves the LATEST web build itself and sends only the
 * machine paths to the computer's daemon. Here the same split runs on
 * loopback so a fresh web build can be driven against an older daemon with
 * no console and no database:
 *
 *   - `/`, `/index.html`, SPA navigations → index.html of the fresh build with
 *     `<meta name="uno-ui" content="origin">` put right after `<head>`;
 *   - `/assets/*` → the fresh build; a miss asks the daemon and lets only a
 *     real file through (an old daemon answers an unknown asset with its own
 *     index.html);
 *   - root icons and the manifest → the fresh build, else the daemon;
 *   - everything else (`/api`, `/ws`, `/.well-known`, `/_*`, `/s`, `/oauth`,
 *     `/attachments`, `/office-engine`, `/skills`, `/onboarding`, root `.html`
 *     / `.js`, every non-GET, every WebSocket) → the daemon, with the
 *     browser's cookies dropped and the daemon session the proxy paired for
 *     itself put in their place. `Set-Cookie` never reaches the browser.
 *
 * Keep `classifyOriginRequest` in step with `classifyWorkUI` in fishcode: a
 * path the console serves from its own build must be served from the fresh
 * build here, or the matrix tests another split than production runs.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { extname, join, normalize, posix, sep } from "node:path";

export const UNO_UI_META_TAG = '<meta name="uno-ui" content="origin">';

/** First path segments the daemon serves itself (fishcode `workUIMachinePrefixes`). */
export const MACHINE_PREFIXES: ReadonlySet<string> = new Set([
  "api",
  "ws",
  "s",
  "oauth",
  "attachments",
  "office-engine",
  "skills",
  "onboarding",
  "assets",
  "enter",
  "logout",
]);

/** Root files taken from the build (fishcode `workUIRootFiles`); root .html/.js stay with the daemon. */
const ROOT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ico",
  ".png",
  ".svg",
  ".webp",
  ".webmanifest",
]);

export type OriginRequestKind =
  /** Forwarded to the daemon. */
  | { readonly kind: "machine" }
  /** index.html of the fresh build (root, /index.html, an SPA navigation). */
  | { readonly kind: "index" }
  /** `/assets/*` of the fresh build. */
  | { readonly kind: "asset"; readonly file: string }
  /** A root icon or the manifest. */
  | { readonly kind: "root"; readonly file: string };

export interface OriginRequestLike {
  readonly method: string;
  readonly path: string;
  readonly accept?: string | undefined;
  readonly upgrade?: string | undefined;
}

function hasHiddenSegment(cleanPath: string): boolean {
  return cleanPath.split("/").some((segment) => segment.startsWith("."));
}

/** The allowlist of what our address serves itself; everything else is the daemon's. */
export function classifyOriginRequest(request: OriginRequestLike): OriginRequestKind {
  const machine = { kind: "machine" } as const;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return machine;
  if ((request.upgrade ?? "").toLowerCase() === "websocket") return machine;
  const raw = request.path.split("?", 1)[0] ?? "/";
  if (raw.includes("\0") || raw.includes("\\")) return machine;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return machine;
  }
  const clean = posix.normalize(`/${decoded}`).replace(/\/+$/, "") || "/";
  if (hasHiddenSegment(clean)) return machine;
  if (clean === "/" || clean === "/index.html") return { kind: "index" };
  if (clean.startsWith("/assets/")) return { kind: "asset", file: clean.slice(1) };
  const [first = "", ...rest] = clean.slice(1).split("/");
  if (rest.length === 0 && ROOT_FILE_EXTENSIONS.has(extname(first).toLowerCase())) {
    return { kind: "root", file: first };
  }
  const wantsHtml = (request.accept ?? "").toLowerCase().includes("text/html");
  if (extname(clean) !== "" || !wantsHtml) return machine;
  if (first.startsWith("_") || MACHINE_PREFIXES.has(first.toLowerCase())) return machine;
  return { kind: "index" };
}

/** The meta right after `<head …>` (or in front when there is no head); never twice. */
export function injectUnoUiMeta(html: string): string {
  if (html.includes('name="uno-ui"')) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return UNO_UI_META_TAG + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + UNO_UI_META_TAG + html.slice(at);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveInside(root: string, relative: string): string | null {
  const full = normalize(join(root, relative));
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/** One answer the daemon gave through the proxy that the matrix may care about. */
export interface MachineAnswer {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly contentType: string;
}

export interface OriginProxyStats {
  /** Requests answered from the fresh build, by kind. */
  readonly served: { index: number; asset: number; root: number };
  /** Requests forwarded to the daemon. */
  forwarded: number;
  /** Daemon answers with status >= 400, and HTML where an API answer was asked for. */
  readonly machineProblems: Array<MachineAnswer>;
  /** WebSocket upgrades forwarded, and how many of those sockets have closed. */
  wsOpened: number;
  wsClosed: number;
}

export interface OriginProxyOptions {
  /** `dist` of the fresh web build (index.html in its root). */
  readonly uiDir: string;
  /** The daemon, e.g. `http://127.0.0.1:13922`. */
  readonly daemonUrl: string;
  /** The daemon session the proxy holds (`name=value; …`), put on every forwarded request. */
  readonly daemonCookie: string;
  /** Name shown in `X-Uno-UI: origin <name>`. */
  readonly uiVersion: string;
  /**
   * When set, only requests carrying the cookie `ACCESS_COOKIE=<token>` are
   * served. The proxy holds an owner session of the daemon: without this,
   * any process on the machine could use the stand as that owner for as long
   * as it runs.
   */
  readonly accessToken?: string;
}

export const ACCESS_COOKIE = "compat_access";

function hasAccess(cookieHeader: string | undefined, token: string | undefined): boolean {
  if (token === undefined) return true;
  return (cookieHeader ?? "")
    .split(";")
    .some((part) => part.trim() === `${ACCESS_COOKIE}=${token}`);
}

export interface OriginProxy {
  readonly server: http.Server;
  readonly stats: OriginProxyStats;
  readonly listen: (port: number, host?: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

function forwardHeaders(
  incoming: http.IncomingHttpHeaders,
  daemon: URL,
  cookie: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...incoming };
  const forwardedHost = incoming.host ?? daemon.host;
  delete headers.cookie;
  headers.cookie = cookie;
  headers.host = daemon.host;
  headers["x-forwarded-host"] = forwardedHost;
  headers["x-forwarded-proto"] = "http";
  return headers;
}

function isApiPath(path: string): boolean {
  return path.startsWith("/api/") || path.startsWith("/.well-known/");
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end("404 page not found\n");
}

export function createOriginProxy(options: OriginProxyOptions): OriginProxy {
  const uiDir = normalize(options.uiDir);
  const daemon = new URL(options.daemonUrl);
  const daemonPort = Number(daemon.port || 80);
  const stats: OriginProxyStats = {
    served: { index: 0, asset: 0, root: 0 },
    forwarded: 0,
    machineProblems: [],
    wsOpened: 0,
    wsClosed: 0,
  };
  const sockets = new Set<net.Socket>();

  const indexHtml = (): string | null => {
    const file = join(uiDir, "index.html");
    return existsSync(file) ? injectUnoUiMeta(readFileSync(file, "utf8")) : null;
  };

  const sendFile = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    file: string,
    cacheControl: string,
  ) => {
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": statSync(file).size,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  };

  /** `onlyRealFile`: an asset our build does not have — the daemon may answer only with a file. */
  const forward = (req: http.IncomingMessage, res: http.ServerResponse, onlyRealFile: boolean) => {
    stats.forwarded += 1;
    const path = req.url ?? "/";
    const upstream = http.request(
      {
        host: daemon.hostname,
        port: daemonPort,
        method: req.method,
        path,
        headers: forwardHeaders(req.headers, daemon, options.daemonCookie),
      },
      (answer) => {
        const status = answer.statusCode ?? 502;
        const contentType = String(answer.headers["content-type"] ?? "").toLowerCase();
        const isHtml = contentType.startsWith("text/html");
        if (onlyRealFile && ((status !== 200 && status !== 304) || isHtml)) {
          answer.resume();
          notFound(res);
          return;
        }
        const pathname = path.split("?", 1)[0] ?? path;
        if (status >= 400 || (isApiPath(pathname) && isHtml)) {
          stats.machineProblems.push({
            method: req.method ?? "GET",
            path: pathname,
            status,
            contentType,
          });
        }
        const headers = { ...answer.headers };
        delete headers["set-cookie"];
        delete headers["service-worker-allowed"];
        res.writeHead(status, headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      stats.machineProblems.push({
        method: req.method ?? "GET",
        path: path.split("?", 1)[0] ?? path,
        status: 502,
        contentType: "",
      });
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("502 the daemon did not answer\n");
    });
    req.pipe(upstream);
  };

  const server = http.createServer((req, res) => {
    if (!hasAccess(req.headers.cookie, options.accessToken)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("403 this stand answers only its own browser\n");
      return;
    }
    const kind = classifyOriginRequest({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      accept: req.headers.accept,
      upgrade: req.headers.upgrade,
    });
    switch (kind.kind) {
      case "index": {
        const body = indexHtml();
        if (body === null) {
          forward(req, res, false);
          return;
        }
        stats.served.index += 1;
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
          "x-uno-ui": `origin ${options.uiVersion}`,
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      case "asset": {
        const file = resolveInside(uiDir, kind.file);
        if (file === null) {
          forward(req, res, true);
          return;
        }
        stats.served.asset += 1;
        sendFile(req, res, file, "public, max-age=31536000, immutable");
        return;
      }
      case "root": {
        const file = resolveInside(uiDir, kind.file);
        if (file === null) {
          forward(req, res, false);
          return;
        }
        stats.served.root += 1;
        sendFile(req, res, file, "public, max-age=3600");
        return;
      }
      case "machine":
        forward(req, res, false);
        return;
    }
  });

  // WebSocket (and any other upgrade): a raw pipe to the daemon with the same
  // header swap as plain requests.
  server.on("upgrade", (req, clientSocket, head) => {
    if (!hasAccess(req.headers.cookie, options.accessToken)) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    stats.wsOpened += 1;
    const upstream = net.connect(daemonPort, daemon.hostname);
    sockets.add(upstream);
    sockets.add(clientSocket as net.Socket);
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      stats.wsClosed += 1;
      upstream.destroy();
      clientSocket.destroy();
      sockets.delete(upstream);
      sockets.delete(clientSocket as net.Socket);
    };
    upstream.on("connect", () => {
      const headers = forwardHeaders(req.headers, daemon, options.daemonCookie);
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", closeBoth);
    upstream.on("close", closeBoth);
    clientSocket.on("error", closeBoth);
    clientSocket.on("close", closeBoth);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    server,
    stats,
    listen: (port, host = "127.0.0.1") =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}
