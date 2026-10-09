import type { UnoMachineApp, UnoMachineApps } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  APP_PROXY_CSP,
  APP_PROXY_TOKEN_TTL_MS,
  appProxyLoopbackUrl,
  appProxyPath,
  appProxyPreflightHeaders,
  appProxyRefusal,
  appProxyRequestHeaders,
  appProxyResponseHeaders,
  appProxyTokenExpiry,
  isAppProxyRequestTarget,
  parseAppProxyPath,
  privateCacheControl,
  rewriteAppLocation,
  signAppProxyToken,
  verifyAppProxyToken,
  withAppProxyPaths,
} from "./appProxy.ts";

const secret = new Uint8Array(32).fill(7);
const otherSecret = new Uint8Array(32).fill(8);
const NOW = Date.UTC(2026, 9, 9, 22, 15, 0);
const HOUR = 60 * 60 * 1000;
const DAEMON_PORTS = new Set([80, 3779]);

function token(input: Partial<{ appId: string; port: number; nowMs: number; key: Uint8Array }>) {
  return signAppProxyToken({
    secret: input.key ?? secret,
    appId: input.appId ?? "ai-limits",
    port: input.port ?? 8693,
    nowMs: input.nowMs ?? NOW,
  });
}

function app(patch: Partial<UnoMachineApp>): UnoMachineApp {
  return {
    id: "manifest:ai-limits",
    source: "manifest",
    name: "Лимиты нейронок",
    description: null,
    icon: "📊",
    iconImage: null,
    status: "running",
    port: 8693,
    udpPorts: [],
    http: true,
    loopbackOnly: false,
    detail: "Registered · port 8693",
    url: null,
    localUrl: "http://localhost:8693/",
    publication: null,
    canStart: false,
    canStop: true,
    ...patch,
  };
}

describe("app proxy tokens", () => {
  it("accepts its own token for the same app and port until it expires", () => {
    const t = token({});
    expect(
      verifyAppProxyToken({ secret, appId: "ai-limits", port: 8693, token: t, nowMs: NOW }),
    ).toBe(true);
    const expires = appProxyTokenExpiry(NOW);
    expect(expires - NOW).toBeGreaterThanOrEqual(APP_PROXY_TOKEN_TTL_MS);
    expect(expires - NOW).toBeLessThanOrEqual(APP_PROXY_TOKEN_TTL_MS + HOUR);
    expect(
      verifyAppProxyToken({ secret, appId: "ai-limits", port: 8693, token: t, nowMs: expires }),
    ).toBe(true);
    expect(
      verifyAppProxyToken({ secret, appId: "ai-limits", port: 8693, token: t, nowMs: expires + 1 }),
    ).toBe(false);
  });

  it("is the same within an hour, so a refetched list doesn't reload the widget", () => {
    expect(token({ nowMs: NOW })).toBe(token({ nowMs: NOW + 10 * 60 * 1000 }));
    expect(token({ nowMs: NOW })).not.toBe(token({ nowMs: NOW + HOUR }));
  });

  it("refuses another app, another port, another key, and garbage", () => {
    const t = token({});
    const check = (patch: Partial<{ appId: string; port: number; key: Uint8Array; t: string }>) =>
      verifyAppProxyToken({
        secret: patch.key ?? secret,
        appId: patch.appId ?? "ai-limits",
        port: patch.port ?? 8693,
        token: patch.t ?? t,
        nowMs: NOW,
      });
    expect(check({ appId: "pult" })).toBe(false);
    expect(check({ port: 8660 })).toBe(false);
    expect(check({ key: otherSecret })).toBe(false);
    expect(check({ t: "" })).toBe(false);
    expect(check({ t: `${t}x` })).toBe(false);
    expect(check({ t: t.replace(/^[0-9a-z]+/, "zzzzzzzz") })).toBe(false);
  });

  it("refuses a token signed for a far future (a key from another build)", () => {
    const far = signAppProxyToken({
      secret,
      appId: "ai-limits",
      port: 8693,
      nowMs: NOW + 10 * 24 * HOUR,
    });
    expect(
      verifyAppProxyToken({ secret, appId: "ai-limits", port: 8693, token: far, nowMs: NOW }),
    ).toBe(false);
  });
});

describe("app proxy paths", () => {
  const t = token({});

  it("splits app id, token and the app's own path, query included", () => {
    expect(parseAppProxyPath(`/_apps/ai-limits/${t}/api/state`, "?x=1")).toEqual({
      kind: "ok",
      appId: "ai-limits",
      token: t,
      upstreamPath: "/api/state?x=1",
    });
    expect(parseAppProxyPath(`/_apps/ai-limits/${t}/`)).toMatchObject({ upstreamPath: "/" });
    expect(parseAppProxyPath(`/_apps/ai-limits/${t}/a%20b/c`)).toMatchObject({
      upstreamPath: "/a%20b/c",
    });
  });

  it("adds the slash relative URLs need", () => {
    expect(parseAppProxyPath(`/_apps/ai-limits/${t}`, "?a=1")).toEqual({
      kind: "add-slash",
      location: `/_apps/ai-limits/${t}/?a=1`,
    });
  });

  it("refuses traversal, odd ids and tokens", () => {
    const bad = [
      `/_apps/ai-limits/${t}/../x`,
      `/_apps/ai-limits/${t}/a/./b`,
      `/_apps/ai-limits/${t}/%2e%2e/x`,
      `/_apps/ai-limits/${t}/.%2E/x`,
      `/_apps/ai-limits/${t}/a%2f..%2fb`,
      `/_apps/ai-limits/${t}/a%5cb`,
      `/_apps/ai-limits/${t}/a\\b`,
      `/_apps/ai-limits/${t}/a%00b`,
      `/_apps/ai-limits/${t}/%E0%A4%A`,
      `/_apps/../${t}/x`,
      `/_apps/AI/${t}/x`,
      `/_apps/ai-limits/not-a-token/x`,
      `/_apps/ai-limits`,
      `/_appsx/ai-limits/${t}/`,
      `/api/_apps/ai-limits/${t}/`,
    ];
    for (const path of bad) expect(parseAppProxyPath(path).kind, path).toBe("invalid");
  });

  it("builds the path the UI resolves", () => {
    expect(appProxyPath("ai-limits", t)).toBe(`/_apps/ai-limits/${t}/`);
    expect(isAppProxyRequestTarget(`/_apps/ai-limits/${t}/x?y`)).toBe(true);
    expect(isAppProxyRequestTarget("/_appsx")).toBe(false);
  });

  it("reads a proxied page on the daemon's loopback for its own checks", () => {
    expect(appProxyLoopbackUrl(`https://box.uno4.work/_apps/ai-limits/${t}/w?a=1`, 80)).toBe(
      `http://127.0.0.1:80/_apps/ai-limits/${t}/w?a=1`,
    );
    expect(appProxyLoopbackUrl("https://box.uno4.work/files/", 80)).toBeUndefined();
    expect(appProxyLoopbackUrl("javascript:alert(1)", 80)).toBeUndefined();
  });
});

describe("which apps the proxy serves", () => {
  it("serves a registered web app on its own port", () => {
    expect(appProxyRefusal(app({}), DAEMON_PORTS)).toBeNull();
  });

  it("refuses everything else", () => {
    expect(
      appProxyRefusal(app({ id: "port:5432", source: "port", port: 5432 }), DAEMON_PORTS),
    ).toBe("not a registered app");
    expect(
      appProxyRefusal(app({ id: "docker:pg", source: "docker", port: 5432 }), DAEMON_PORTS),
    ).toBe("not a registered app");
    expect(appProxyRefusal(app({ loopbackOnly: true }), DAEMON_PORTS)).toBe(
      "listens on 127.0.0.1 only",
    );
    expect(appProxyRefusal(app({ port: 80 }), DAEMON_PORTS)).toBe("a system port");
    expect(appProxyRefusal(app({ port: 22 }), DAEMON_PORTS)).toBe("a system port");
    expect(appProxyRefusal(app({ port: 3779 }), DAEMON_PORTS)).toBe("Uno Work's own port");
    expect(appProxyRefusal(app({ port: 13773 }), new Set([13773]))).toBe("Uno Work's own port");
    expect(appProxyRefusal(app({ port: null }), DAEMON_PORTS)).toBe("no port");
    expect(appProxyRefusal(app({ port: 70_000 }), DAEMON_PORTS)).toBe("a system port");
    expect(
      appProxyRefusal(
        app({ telegramBot: { username: "x", link: null, tokenReady: true } }),
        DAEMON_PORTS,
      ),
    ).toBe("a Telegram bot");
  });

  it("puts a proxy link only on running registered web apps of the UI's list", () => {
    const list: UnoMachineApps = {
      apps: [
        app({}),
        app({ id: "manifest:stopped", status: "stopped" }),
        app({ id: "manifest:private", loopbackOnly: true }),
        app({ id: "manifest:nothttp", http: false }),
        app({ id: "port:5432", source: "port", port: 5432 }),
      ],
      manifestDir: "~/.uno/apps",
      scannedAt: "now",
      publishBlockedReason: null,
      warnings: [],
    };
    const linked = withAppProxyPaths(list, { secret, daemonPorts: DAEMON_PORTS, nowMs: NOW });
    expect(linked.apps.map((a) => a.proxyPath ?? null)).toEqual([
      `/_apps/ai-limits/${token({})}/`,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("app proxy headers", () => {
  it("forwards the browser's request without Work's cookies or hop-by-hop headers", () => {
    const out = appProxyRequestHeaders({
      headers: {
        host: "box.uno4.work",
        cookie: "t3_session=secret",
        connection: "keep-alive, x-drop-me",
        "x-drop-me": "1",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        upgrade: "websocket",
        "proxy-authorization": "Basic x",
        "x-forwarded-for": "1.2.3.4",
        accept: "application/json",
        "accept-encoding": "gzip",
        origin: "null",
      },
      port: 8693,
      prefix: "/_apps/ai-limits/tok/",
      publicHost: "box.uno4.work",
      publicProto: "https",
    });
    expect(out).toEqual({
      host: "127.0.0.1:8693",
      accept: "application/json",
      "accept-encoding": "gzip",
      origin: "null",
      "x-forwarded-proto": "https",
      "x-forwarded-prefix": "/_apps/ai-limits/tok",
      "x-forwarded-host": "box.uno4.work",
    });
  });

  it("answers with the sandbox, no-referrer, CORS, and nothing that touches Work's origin", () => {
    const out = appProxyResponseHeaders({
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-length": "12",
        "set-cookie": ["a=1; Domain=uno4.work", "b=2"],
        "clear-site-data": '"cookies"',
        "strict-transport-security": "max-age=1",
        nel: "{}",
        "report-to": "{}",
        "service-worker-allowed": "/",
        "access-control-allow-origin": "https://evil.example",
        "access-control-allow-credentials": "true",
        "www-authenticate": "Basic",
        "transfer-encoding": "chunked",
        connection: "close",
        "x-secret-header": "1",
        "referrer-policy": "unsafe-url",
        etag: '"abc"',
      },
      port: 8693,
      prefix: "/_apps/ai-limits/tok/",
    });
    expect(out).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-length": "12",
      etag: '"abc"',
      "cache-control": "private, no-cache",
      "content-security-policy": APP_PROXY_CSP,
      "referrer-policy": "no-referrer",
      "access-control-allow-origin": "*",
      "x-robots-tag": "noindex, nofollow",
    });
    expect(APP_PROXY_CSP).toMatch(/^sandbox /);
    expect(APP_PROXY_CSP).not.toContain("allow-same-origin");
    expect(APP_PROXY_CSP).not.toContain("allow-top-navigation");
  });

  it("keeps the app's own CSP next to the sandbox (both are enforced)", () => {
    const out = appProxyResponseHeaders({
      headers: { "content-security-policy": "default-src 'self'" },
      port: 8693,
      prefix: "/_apps/a/t/",
    });
    expect(out["content-security-policy"]).toBe(`${APP_PROXY_CSP}, default-src 'self'`);
  });

  it("keeps redirects into the app under the prefix", () => {
    const prefix = "/_apps/ai-limits/tok/";
    expect(rewriteAppLocation("/login?next=%2F", 8693, prefix)).toBe(
      "/_apps/ai-limits/tok/login?next=%2F",
    );
    expect(rewriteAppLocation("http://127.0.0.1:8693/a#b", 8693, prefix)).toBe(
      "/_apps/ai-limits/tok/a#b",
    );
    expect(rewriteAppLocation("http://localhost:8693/", 8693, prefix)).toBe(
      "/_apps/ai-limits/tok/",
    );
    expect(rewriteAppLocation("login", 8693, prefix)).toBe("login");
    expect(rewriteAppLocation("//evil.example/x", 8693, prefix)).toBe("//evil.example/x");
    expect(rewriteAppLocation("http://127.0.0.1:9999/", 8693, prefix)).toBe(
      "http://127.0.0.1:9999/",
    );
    expect(rewriteAppLocation("https://accounts.example/", 8693, prefix)).toBe(
      "https://accounts.example/",
    );
    expect(
      appProxyResponseHeaders({ headers: { location: "/x" }, port: 8693, prefix }).location,
    ).toBe("/_apps/ai-limits/tok/x");
  });

  it("never lets a CDN keep the app's pages", () => {
    expect(privateCacheControl(undefined)).toBe("private, no-cache");
    expect(privateCacheControl("public, max-age=60, s-maxage=600")).toBe("private, max-age=60");
    expect(privateCacheControl("no-store")).toBe("no-store");
  });

  it("answers the page's preflight itself", () => {
    expect(
      appProxyPreflightHeaders({
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      }),
    ).toMatchObject({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
    });
    expect(
      appProxyPreflightHeaders({ "access-control-request-method": "PO\r\nST" })[
        "access-control-allow-methods"
      ],
    ).toBe("GET");
  });
});
