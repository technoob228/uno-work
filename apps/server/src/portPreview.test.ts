import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Net from "node:net";
import * as Zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  looksLikeHtmlDocument,
  PAGE_TOOLS_SCRIPT_TAG,
  pageToolsInsertIndex,
  pageToolsRequestKind,
  portPreviewRequestHeaders,
  type PortPreviewTarget,
  relayPortPreviewRequest,
  relayPortPreviewUpgrade,
  rewritePortPreviewLocation,
  servePageToolsScript,
  stripSessionCookie,
} from "./portPreview.ts";
import { portPreviewPortProblem } from "./portPreviewHttp.ts";

const PUBLIC_HOST = "p5173--abc123.uno4.work";
const servers: Http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

function listen(server: Http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

/** A free port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = Net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A plain GET with exactly these headers (fetch() adds its own Sec-Fetch-* and decompresses). */
function get(
  port: number,
  path: string,
  headers: Http.OutgoingHttpHeaders = {},
): Promise<{ status: number; headers: Http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = Http.get({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

function scriptTagsIn(body: string): number {
  return body.split(PAGE_TOOLS_SCRIPT_TAG).length - 1;
}

/** The daemon's side: every request relayed to `port` (as portPreviewHttp does after auth). */
async function startRelay(port: number): Promise<number> {
  const target = (): PortPreviewTarget => ({
    port,
    publicHost: PUBLIC_HOST,
    sessionCookieName: "t3_session",
  });
  const relay = Http.createServer((req, res) => {
    if (req.url === "/__uno/page-tools.js") servePageToolsScript(req, res);
    else void relayPortPreviewRequest(req, res, target());
  });
  relay.on("upgrade", (req, socket, head) => {
    void relayPortPreviewUpgrade(req, socket as Net.Socket, head, target());
  });
  return listen(relay);
}

describe("port preview headers", () => {
  it("strips the daemon session cookie, restores the app's Authorization, drops X-Uno-*", () => {
    const headers = portPreviewRequestHeaders(
      {
        host: "127.0.0.1:80",
        cookie: "a=1; t3_session=secret; b=2",
        authorization: "Bearer agent-token",
        "x-uno-app-authorization": "Basic app",
        "x-uno-port-preview": "5173",
        "x-forwarded-host": PUBLIC_HOST,
        "x-forwarded-proto": "https",
        origin: `https://${PUBLIC_HOST}`,
        referer: `https://${PUBLIC_HOST}/about?x=1`,
        "sec-fetch-dest": "document",
        "accept-encoding": "gzip, br",
        connection: "keep-alive",
      },
      { port: 5173, publicHost: PUBLIC_HOST, sessionCookieName: "t3_session" },
      { upgrade: false },
    );
    expect(headers).toEqual({
      host: "localhost:5173",
      cookie: "a=1; b=2",
      authorization: "Basic app",
      origin: "http://localhost:5173",
      referer: "http://localhost:5173/about?x=1",
      "sec-fetch-dest": "document",
      "accept-encoding": "identity",
    });
  });

  it("drops Authorization and Cookie when the page had none", () => {
    const headers = portPreviewRequestHeaders(
      { cookie: "t3_session=secret", authorization: "Bearer agent", accept: "*/*" },
      { port: 3000, publicHost: null, sessionCookieName: "t3_session" },
      { upgrade: false },
    );
    expect(headers["cookie"]).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    expect(stripSessionCookie("t3_session=x", "t3_session")).toBeNull();
  });

  it("rewrites redirects to localhost:PORT only", () => {
    const target = { port: 5173, publicHost: PUBLIC_HOST };
    expect(rewritePortPreviewLocation("http://localhost:5173/x?y#z", target)).toBe(
      `https://${PUBLIC_HOST}/x?y#z`,
    );
    expect(rewritePortPreviewLocation("http://127.0.0.1:5173/", target)).toBe(
      `https://${PUBLIC_HOST}/`,
    );
    expect(rewritePortPreviewLocation("/relative", target)).toBe("/relative");
    expect(rewritePortPreviewLocation("http://localhost:3000/", target)).toBe(
      "http://localhost:3000/",
    );
    expect(rewritePortPreviewLocation("https://example.com/", target)).toBe("https://example.com/");
  });

  it("puts the script after <head>, else after <html>/doctype, waiting for more otherwise", () => {
    const at = (html: string, complete = true) => pageToolsInsertIndex(Buffer.from(html), complete);
    expect(at('<!doctype html><html lang="en"><head><title>x')).toBe(
      '<!doctype html><html lang="en"><head>'.length,
    );
    expect(at("<!doctype html><html><body>hi</body></html>")).toBe("<!doctype html><html>".length);
    expect(at("<!DOCTYPE html><p>hi")).toBe("<!DOCTYPE html>".length);
    expect(at("<!doctype html><html>", false)).toBeNull();
    expect(at("<header>not head</header>")).toBe(0);
  });

  it("tells a page from data labelled text/html", () => {
    const doc = (body: string, complete = true) =>
      looksLikeHtmlDocument(Buffer.from(body), complete);
    expect(doc("<!doctype html><html><head></head></html>")).toBe(true);
    expect(doc("﻿  <!-- built 29.10 -->\n<!DOCTYPE HTML><p>hi")).toBe(true);
    expect(doc('<html lang="en"><body>x</body></html>')).toBe(true);
    expect(doc('<meta charset="utf-8"><title>x</title><body>hi')).toBe(true);
    expect(doc('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">')).toBe(true);
    expect(doc("42")).toBe(false);
    expect(doc("42", false)).toBe(false);
    expect(doc('{"count":42}')).toBe(false);
    expect(doc("[1,2,3]")).toBe(false);
    expect(doc("Count: 42")).toBe(false);
    expect(doc("<li>one</li><li>two</li>")).toBe(false);
    expect(doc("<header>not head</header>")).toBe(false);
    expect(doc("")).toBe(false);
    // Not enough yet to tell.
    expect(doc("  ", false)).toBeNull();
    expect(doc("<!-- still a comm", false)).toBeNull();
    expect(doc("<!doc", false)).toBeNull();
    expect(doc("<div>", false)).toBeNull();
  });

  it("knows a page request from a fetch by Sec-Fetch-Dest", () => {
    expect(pageToolsRequestKind({ "sec-fetch-dest": "document" })).toBe("page");
    expect(pageToolsRequestKind({ "sec-fetch-dest": "iframe" })).toBe("page");
    expect(pageToolsRequestKind({ "sec-fetch-dest": "frame" })).toBe("page");
    expect(pageToolsRequestKind({ "sec-fetch-dest": "empty" })).toBe("data");
    expect(pageToolsRequestKind({ "sec-fetch-dest": "script" })).toBe("data");
    expect(pageToolsRequestKind({})).toBe("unknown");
  });

  it("refuses ports outside 1024–65535 and Work's own", () => {
    const reserved = { daemonPort: 80, appApiPort: 3779 };
    expect(portPreviewPortProblem("5173", reserved)).toBeNull();
    expect(portPreviewPortProblem("80", reserved)).not.toBeNull();
    expect(portPreviewPortProblem("3779", reserved)).not.toBeNull();
    expect(portPreviewPortProblem("70000", reserved)).not.toBeNull();
    expect(portPreviewPortProblem("abc", reserved)).not.toBeNull();
  });
});

describe("port preview relay", () => {
  it("relays a page: script injected, frame blockers and session cookie gone", async () => {
    let seen: Http.IncomingHttpHeaders = {};
    const app = Http.createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
        "set-cookie": "app=1; Path=/",
      });
      res.end("<!doctype html><html><head><title>App</title></head><body>hi</body></html>");
    });
    const appPort = await listen(app);
    const relay = await startRelay(appPort);
    const response = await fetch(`http://127.0.0.1:${relay}/about`, {
      headers: {
        cookie: "t3_session=secret; theme=dark",
        "sec-fetch-dest": "iframe",
        "x-forwarded-host": PUBLIC_HOST,
      },
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toBe(
      `<!doctype html><html><head>${PAGE_TOOLS_SCRIPT_TAG}<title>App</title></head><body>hi</body></html>`,
    );
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("set-cookie")).toBe("app=1; Path=/");
    expect(seen.cookie).toBe("theme=dark");
    expect(seen.host).toBe(`localhost:${appPort}`);
    expect(seen["accept-encoding"]).toBe("identity");
  });

  it("unpacks a gzip page the app compressed anyway", async () => {
    const app = Http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(Zlib.gzipSync("<html><head></head><body>z</body></html>"));
    });
    const relay = await startRelay(await listen(app));
    const response = await fetch(`http://127.0.0.1:${relay}/`, {
      headers: { "sec-fetch-dest": "document" },
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(
      `<html><head>${PAGE_TOOLS_SCRIPT_TAG}</head><body>z</body></html>`,
    );
  });

  describe("only real pages get the script (29.10: Date Counter read `42<script…>`)", () => {
    /** An app whose endpoints label everything text/html, like the agent-built one did. */
    async function startHtmlApp(): Promise<number> {
      const page =
        '<!doctype html><html><head><title>Date Counter</title></head><body><p id="c"></p></body></html>';
      const app = Http.createServer((req, res) => {
        if (req.url === "/count") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": 2 });
          res.end("42");
        } else if (req.url === "/stats") {
          const json = JSON.stringify({ count: 42, since: "2026-10-29" });
          res.writeHead(200, {
            "content-type": "text/html",
            "content-length": Buffer.byteLength(json),
          });
          res.end(json);
        } else if (req.url === "/count.gz") {
          res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
          res.end(Zlib.gzipSync("42"));
        } else if (req.url === "/streamed") {
          // The page arrives in pieces: the verdict waits for enough of it.
          res.writeHead(200, { "content-type": "text/html" });
          res.write("\n  <!-- app -->\n<!doc");
          setTimeout(() => {
            res.write("type html><html><he");
            setTimeout(() => res.end("ad><title>x</title></head><body>hi</body></html>"), 10);
          }, 10);
        } else {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(page),
          });
          res.end(page);
        }
      });
      return startRelay(await listen(app));
    }

    it("a bare number labelled text/html goes through untouched, Content-Length kept", async () => {
      const relay = await startHtmlApp();
      const response = await get(relay, "/count");
      expect(response.status).toBe(200);
      expect(response.body.toString()).toBe("42");
      expect(response.headers["content-length"]).toBe("2");
    });

    it("JSON labelled text/html goes through untouched", async () => {
      const relay = await startHtmlApp();
      const response = await get(relay, "/stats");
      const body = response.body.toString();
      expect(JSON.parse(body)).toEqual({ count: 42, since: "2026-10-29" });
      expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    });

    it("a compressed number with no Sec-Fetch-Dest comes back unpacked, without the script", async () => {
      const relay = await startHtmlApp();
      const response = await get(relay, "/count.gz", { "accept-encoding": "gzip" });
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.body.toString()).toBe("42");
    });

    it("a full HTML page gets the script once (no Sec-Fetch-Dest, page in pieces)", async () => {
      const relay = await startHtmlApp();
      const whole = await get(relay, "/", { accept: "text/html" });
      const body = whole.body.toString();
      expect(scriptTagsIn(body)).toBe(1);
      expect(body).toBe(
        `<!doctype html><html><head>${PAGE_TOOLS_SCRIPT_TAG}<title>Date Counter</title></head><body><p id="c"></p></body></html>`,
      );
      expect(whole.headers["content-length"]).toBeUndefined();

      const streamed = (await get(relay, "/streamed")).body.toString();
      expect(scriptTagsIn(streamed)).toBe(1);
      expect(streamed).toBe(
        `\n  <!-- app -->\n<!doctype html><html><head>${PAGE_TOOLS_SCRIPT_TAG}<title>x</title></head><body>hi</body></html>`,
      );
    });

    it("a fetch (Sec-Fetch-Dest: empty) of an HTML page gets it untouched", async () => {
      const relay = await startHtmlApp();
      const page = await get(relay, "/", { "sec-fetch-dest": "empty", accept: "*/*" });
      const body = page.body.toString();
      expect(scriptTagsIn(body)).toBe(0);
      expect(page.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
      const count = await get(relay, "/count", { "sec-fetch-dest": "empty" });
      expect(count.body.toString()).toBe("42");
      const gz = await get(relay, "/count.gz", {
        "sec-fetch-dest": "empty",
        "accept-encoding": "gzip",
      });
      expect(gz.headers["content-encoding"]).toBe("gzip");
      expect(Zlib.gunzipSync(gz.body).toString()).toBe("42");
    });

    it("an iframe (or frame) navigation gets the script", async () => {
      const relay = await startHtmlApp();
      for (const dest of ["iframe", "frame", "document"]) {
        const body = (await get(relay, "/", { "sec-fetch-dest": dest })).body.toString();
        expect(scriptTagsIn(body)).toBe(1);
        expect(body.startsWith(`<!doctype html><html><head>${PAGE_TOOLS_SCRIPT_TAG}`)).toBe(true);
      }
    });
  });

  it("passes other content untouched and rewrites the Location", async () => {
    const app = Http.createServer((req, res) => {
      if (req.url === "/go") {
        res.writeHead(302, {
          location: `http://localhost:${req.headers.host?.split(":")[1]}/next`,
        });
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ got: body, method: req.method }));
      });
    });
    const appPort = await listen(app);
    const relay = await startRelay(appPort);
    const posted = await fetch(`http://127.0.0.1:${relay}/api`, { method: "POST", body: "ping" });
    expect(await posted.json()).toEqual({ got: "ping", method: "POST" });
    const redirect = await fetch(`http://127.0.0.1:${relay}/go`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`https://${PUBLIC_HOST}/next`);
  });

  it("answers 502 with a plain page when nothing listens", async () => {
    const relay = await startRelay(await closedPort());
    const response = await fetch(`http://127.0.0.1:${relay}/`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("Nothing is running on port");
  });

  it("serves the page script for the postMessage channel", async () => {
    const relay = await startRelay(await closedPort());
    const response = await fetch(`http://127.0.0.1:${relay}/__uno/page-tools.js`);
    expect(response.headers.get("content-type")).toContain("javascript");
    const script = await response.text();
    expect(script).toContain('"standalone"');
    // A port's page: no verify step (its parent is read off its own host).
    expect(script.trim().endsWith('("", false, true, "");')).toBe(true);
  });

  it("pipes a WebSocket upgrade both ways", async () => {
    const app = Http.createServer();
    let upgradeHost: string | undefined;
    let upgradeCookie: string | undefined;
    const appSockets: Net.Socket[] = [];
    app.on("upgrade", (req, socket) => {
      appSockets.push(socket as Net.Socket);
      upgradeHost = req.headers.host;
      upgradeCookie = req.headers.cookie;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`));
    });
    const appPort = await listen(app);
    const relay = await startRelay(appPort);
    const client = Net.connect(relay, "127.0.0.1");
    const received = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      client.on("error", reject);
      client.on("data", (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes("\r\n\r\n") && !buffer.includes("echo:")) client.write("hello");
        if (buffer.includes("echo:hello")) resolve(buffer);
      });
      client.write(
        "GET /hmr HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
          "Cookie: t3_session=secret\r\n\r\n",
      );
    });
    client.destroy();
    for (const socket of appSockets) socket.destroy();
    expect(received.startsWith("HTTP/1.1 101")).toBe(true);
    expect(upgradeHost).toBe(`localhost:${appPort}`);
    expect(upgradeCookie).toBeUndefined();
  });
});
