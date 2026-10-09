import http from "node:http";
import type { AddressInfo } from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { APP_PROXY_CSP, signAppProxyToken } from "./appProxy.ts";
import { appProxyRouteLayer } from "./appProxyHttp.ts";
import { MachineAppsService } from "./MachineAppsService.ts";
import type { ScannedApp } from "./machineAppsScan.ts";

const SECRET = new Uint8Array(32).fill(3);

function scanned(patch: Partial<ScannedApp>): ScannedApp {
  return {
    id: "manifest:ai-limits",
    source: "manifest",
    name: "AI limits",
    description: null,
    icon: null,
    iconImage: null,
    status: "running",
    port: 8693,
    udpPorts: [],
    http: true,
    loopbackOnly: false,
    detail: null,
    url: null,
    localUrl: null,
    canStart: false,
    canStop: true,
    canRemove: true,
    composeProject: null,
    control: { kind: "process", pid: 999_999 },
    manifest: null,
    ...patch,
  };
}

/** A tiny app on a random loopback port, as a registered app would be. */
const startApp = Effect.acquireRelease(
  Effect.promise(async () => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (req.url === "/widget") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "set-cookie": "app=1; Path=/",
            "clear-site-data": '"cookies"',
          });
          res.end("<p>widget</p>");
          return;
        }
        if (req.url === "/go") {
          res.writeHead(302, { location: "/login?next=%2F" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            host: req.headers.host ?? null,
            cookie: req.headers.cookie ?? null,
            prefix: req.headers["x-forwarded-prefix"] ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
  }),
  (server) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
);

const makeFixture = Effect.gen(function* () {
  const server = yield* startApp;
  const port = (server.address() as AddressInfo).port;
  // A port nothing listens on: the "app is down" case.
  const downPort = yield* Effect.promise(async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const free = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return free;
  });
  const apps: ReadonlyArray<ScannedApp> = [
    scanned({ port }),
    scanned({ id: "manifest:private", port, loopbackOnly: true }),
    scanned({ id: "manifest:web-port", port: 80 }),
    scanned({ id: "manifest:down", port: downPort }),
    scanned({ id: "port:5432", source: "port", port }),
  ];
  const context = yield* Layer.build(
    Layer.mergeAll(
      Layer.mock(SessionCredentialService)({ deriveSecret: () => Effect.succeed(SECRET) }),
      Layer.mock(MachineAppsService)({
        lastScanned: Effect.succeed(apps.map((app) => ({ ...app, hidden: false }))),
        scanned: Effect.succeed(apps),
      }),
      Layer.succeed(ServerConfig, { port: 80 } as ServerConfigShape),
      NodeServices.layer,
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(appProxyRouteLayer, {
    disableLogger: true,
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
  const tokenFor = (appId: string, appPort: number) =>
    signAppProxyToken({ secret: SECRET, appId, port: appPort, nowMs: Date.now() });
  const send = (path: string, init: RequestInit = {}) =>
    Effect.promise(() => handler(new Request(`http://box.example${path}`, init), context));
  return { port, downPort, send, tokenFor };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("app proxy route", (it) => {
  it.effect("serves the app's widget sandboxed, without its cookies or Clear-Site-Data", () =>
    Effect.gen(function* () {
      const { port, send, tokenFor } = yield* makeFixture;
      const response = yield* send(`/_apps/ai-limits/${tokenFor("ai-limits", port)}/widget`);
      assert.equal(response.status, 200);
      assert.equal(yield* Effect.promise(() => response.text()), "<p>widget</p>");
      assert.equal(response.headers.get("content-security-policy"), APP_PROXY_CSP);
      assert.notInclude(APP_PROXY_CSP, "allow-same-origin");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("clear-site-data"), null);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
    }).pipe(Effect.scoped),
  );

  it.effect("forwards method, path, query and body; never Work's cookie or Host", () =>
    Effect.gen(function* () {
      const { port, send, tokenFor } = yield* makeFixture;
      const token = tokenFor("ai-limits", port);
      const response = yield* send(`/_apps/ai-limits/${token}/api/refresh?x=1`, {
        method: "POST",
        body: '{"a":1}',
        headers: {
          "content-type": "application/json",
          cookie: "t3_session=owner-session",
          "x-forwarded-proto": "https",
        },
      });
      assert.equal(response.status, 200);
      const echo = (yield* Effect.promise(() => response.json())) as Record<string, unknown>;
      assert.deepEqual(echo, {
        method: "POST",
        url: "/api/refresh?x=1",
        host: `127.0.0.1:${port}`,
        cookie: null,
        prefix: `/_apps/ai-limits/${token}`,
        body: '{"a":1}',
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the app's redirects under its prefix", () =>
    Effect.gen(function* () {
      const { port, send, tokenFor } = yield* makeFixture;
      const token = tokenFor("ai-limits", port);
      const response = yield* send(`/_apps/ai-limits/${token}/go`, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), `/_apps/ai-limits/${token}/login?next=%2F`);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses bad, foreign and expired tokens alike, and unknown apps the same way", () =>
    Effect.gen(function* () {
      const { port, send, tokenFor } = yield* makeFixture;
      const forged = signAppProxyToken({
        secret: new Uint8Array(32).fill(9),
        appId: "ai-limits",
        port,
        nowMs: Date.now(),
      });
      const expired = signAppProxyToken({
        secret: SECRET,
        appId: "ai-limits",
        port,
        nowMs: Date.now() - 14 * 60 * 60 * 1000,
      });
      for (const path of [
        `/_apps/ai-limits/${forged}/widget`,
        `/_apps/ai-limits/${expired}/widget`,
        `/_apps/ai-limits/${tokenFor("other", port)}/widget`,
        `/_apps/ai-limits/${tokenFor("ai-limits", port + 7)}/widget`,
        `/_apps/nope/${tokenFor("nope", port)}/widget`,
      ]) {
        const response = yield* send(path);
        assert.equal(response.status, 401, path);
        assert.include(response.headers.get("content-security-policy") ?? "", "sandbox");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("never proxies loopback-only apps, system/Work ports or found ports", () =>
    Effect.gen(function* () {
      const { port, send, tokenFor } = yield* makeFixture;
      const priv = yield* send(`/_apps/private/${tokenFor("private", port)}/`);
      assert.equal(priv.status, 403);
      const work = yield* send(`/_apps/web-port/${tokenFor("web-port", 80)}/`);
      assert.equal(work.status, 403);
      // A found port has no manifest id: it can't even be named in the path.
      const found = yield* send(`/_apps/port:5432/${tokenFor("port:5432", port)}/`);
      assert.equal(found.status, 404);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses traversal and asks for the slash relative URLs need", () =>
    Effect.gen(function* () {
      const { port, send, tokenFor } = yield* makeFixture;
      const token = tokenFor("ai-limits", port);
      const traversal = yield* send(`/_apps/ai-limits/${token}/a/%2e%2e/%2e%2e/etc/passwd`);
      assert.equal(traversal.status, 404);
      const bare = yield* send(`/_apps/ai-limits/${token}?a=1`, { redirect: "manual" });
      assert.equal(bare.status, 308);
      assert.equal(bare.headers.get("location"), `/_apps/ai-limits/${token}/?a=1`);
    }).pipe(Effect.scoped),
  );

  it.effect("answers the page's CORS preflight and says when the app is down", () =>
    Effect.gen(function* () {
      const { port, downPort, send, tokenFor } = yield* makeFixture;
      const preflight = yield* send(`/_apps/ai-limits/${tokenFor("ai-limits", port)}/api/x`, {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");
      const down = yield* send(`/_apps/down/${tokenFor("down", downPort)}/`);
      assert.equal(down.status, 502);
    }).pipe(Effect.scoped),
  );
});
