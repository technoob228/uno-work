import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  apiRoutesMissingFromBundle,
  apiRoutesOfWebBuild,
  compareVersions,
  defaultDaemonSpecs,
  parseDaemonSpecs,
  parseReleaseSums,
  rpcMethodsMissingFromBundle,
} from "./daemons.ts";
import {
  emptyRpcSocketState,
  emptyRpcTraffic,
  findRawError,
  judgeHttpRoutes,
  judgeRpcMethods,
  judgeTurnOutcome,
  recordRpcFrame,
  refusedCommands,
  unexplainedMachineProblems,
} from "./findings.ts";
import {
  ACCESS_COOKIE,
  classifyOriginRequest,
  createOriginProxy,
  injectUnoUiMeta,
} from "./originProxy.ts";
import { formatMatrix } from "./report.ts";
import { CHECKS, failed, type SmokeResults } from "./smoke.ts";

const HTML = "text/html,application/xhtml+xml";
const kindOf = (method: string, path: string, accept?: string, upgrade?: string) =>
  classifyOriginRequest({ method, path, accept, upgrade }).kind;

describe("origin proxy: what our address serves and what goes to the computer", () => {
  it("serves the interface itself: root, assets, icons, SPA navigations", () => {
    assert.equal(kindOf("GET", "/", HTML), "index");
    assert.equal(kindOf("GET", "/index.html"), "index");
    assert.equal(kindOf("HEAD", "/"), "index");
    assert.equal(kindOf("GET", "/settings/general", HTML), "index");
    assert.equal(kindOf("GET", "/computer?x=1", HTML), "index");
    assert.deepStrictEqual(classifyOriginRequest({ method: "GET", path: "/assets/main-abc.js" }), {
      kind: "asset",
      file: "assets/main-abc.js",
    });
    assert.deepStrictEqual(classifyOriginRequest({ method: "GET", path: "/favicon.svg" }), {
      kind: "root",
      file: "favicon.svg",
    });
    assert.equal(kindOf("GET", "/manifest.webmanifest"), "root");
  });

  it("sends the machine paths to the daemon", () => {
    for (const path of [
      "/api/auth/session",
      "/ws",
      "/.well-known/t3/environment",
      "/_account/overview",
      "/_work/open",
      "/s/abc",
      "/oauth/callback",
      "/attachments/1",
      "/office-engine/vendor",
      "/skills/catalog",
      "/onboarding/step",
      "/enter",
      "/logout",
    ]) {
      assert.equal(kindOf("GET", path, HTML), "machine", path);
    }
    // Root .html/.js stay with the daemon (office-share.html, the service worker).
    assert.equal(kindOf("GET", "/office-share.html", HTML), "machine");
    assert.equal(kindOf("GET", "/mockServiceWorker.js"), "machine");
    // Not a navigation: no text/html asked for.
    assert.equal(kindOf("GET", "/settings/general", "application/json"), "machine");
    // Everything that is not GET/HEAD, and every WebSocket.
    assert.equal(kindOf("POST", "/", HTML), "machine");
    assert.equal(kindOf("GET", "/", HTML, "websocket"), "machine");
    // Nothing clever with paths.
    assert.equal(kindOf("GET", "/assets/..%2f..%2fetc/passwd"), "machine");
    assert.equal(kindOf("GET", "/a\\b", HTML), "machine");
  });

  it("puts the uno-ui meta right after <head>, once", () => {
    const out = injectUnoUiMeta(
      '<!doctype html><html><head lang="en"><title>x</title></head></html>',
    );
    assert.include(out, '<head lang="en"><meta name="uno-ui" content="origin"><title>');
    assert.equal(injectUnoUiMeta(out), out);
    assert.equal(injectUnoUiMeta("<p>x</p>"), '<meta name="uno-ui" content="origin"><p>x</p>');
  });

  it("serves the fresh build, forwards the rest with the proxy's own session, hides Set-Cookie", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compat-proxy-test-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html><head></head><body>fresh</body></html>");
    writeFileSync(join(dir, "assets", "main-1.js"), "console.log('fresh')");
    const seen: Array<{ url: string; cookie: string | undefined }> = [];
    const daemon = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "", cookie: req.headers.cookie });
      if (req.url === "/assets/old-chunk.js") {
        res.writeHead(200, { "content-type": "text/javascript" }).end("old chunk");
      } else if (req.url?.startsWith("/assets/")) {
        // What an old daemon does with an asset it does not have.
        res.writeHead(200, { "content-type": "text/html" }).end("<html>daemon index</html>");
      } else if (req.url === "/api/gone") {
        res.writeHead(404, { "content-type": "application/json" }).end("{}");
      } else {
        res
          .writeHead(200, { "content-type": "application/json", "set-cookie": "t3_session=leak" })
          .end('{"ok":true}');
      }
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    const daemonPort = (daemon.address() as AddressInfo).port;
    const proxy = createOriginProxy({
      uiDir: dir,
      daemonUrl: `http://127.0.0.1:${daemonPort}`,
      daemonCookie: "t3_session=proxy",
      uiVersion: "9.9.9",
    });
    await proxy.listen(0);
    const base = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
    try {
      const index = await fetch(`${base}/projects/a`, { headers: { accept: HTML } });
      assert.equal(index.headers.get("x-uno-ui"), "origin 9.9.9");
      assert.equal(index.headers.get("cache-control"), "no-cache");
      assert.include(await index.text(), '<meta name="uno-ui" content="origin">');

      const asset = await fetch(`${base}/assets/main-1.js`);
      assert.equal(await asset.text(), "console.log('fresh')");
      assert.include(asset.headers.get("cache-control") ?? "", "immutable");

      // An asset of the daemon's own interface (a tab opened before the switch).
      assert.equal(await (await fetch(`${base}/assets/old-chunk.js`)).text(), "old chunk");
      // index.html under a script's name is a 404, never a cached "script".
      const miss = await fetch(`${base}/assets/nowhere.js`);
      assert.equal(miss.status, 404);
      assert.equal(miss.headers.get("cache-control"), "no-store");

      const api = await fetch(`${base}/api/auth/session`, { headers: { cookie: "browser=1" } });
      assert.equal(api.status, 200);
      assert.equal(api.headers.get("set-cookie"), null);
      assert.equal(
        seen.find((entry) => entry.url === "/api/auth/session")?.cookie,
        "t3_session=proxy",
      );

      await fetch(`${base}/api/gone`);
      assert.deepStrictEqual(
        proxy.stats.machineProblems.map((problem) => `${problem.path} ${problem.status}`),
        ["/api/gone 404"],
      );
      assert.equal(proxy.stats.served.index, 1);
      assert.equal(proxy.stats.served.asset, 1);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve) => daemon.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("origin proxy: only the stand's own browser", () => {
  it("answers 403 without the access cookie, plain requests and WebSocket alike", async () => {
    const dir = mkdtempSync(join(tmpdir(), "compat-proxy-test-"));
    writeFileSync(join(dir, "index.html"), "<html><head></head></html>");
    const proxy = createOriginProxy({
      uiDir: dir,
      daemonUrl: "http://127.0.0.1:9",
      daemonCookie: "t3_session=proxy",
      uiVersion: "9.9.9",
      accessToken: "secret",
    });
    await proxy.listen(0);
    const port = (proxy.server.address() as AddressInfo).port;
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 403);
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
            headers: { cookie: `${ACCESS_COOKIE}=wrong` },
          })
        ).status,
        403,
      );
      const allowed = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { cookie: `other=1; ${ACCESS_COOKIE}=secret` },
      });
      assert.equal(allowed.status, 200);
      const upgrade = await new Promise<string>((resolve, reject) => {
        const request = http.request({
          host: "127.0.0.1",
          port,
          path: "/ws",
          headers: { connection: "Upgrade", upgrade: "websocket" },
        });
        request.on("response", (response) => resolve(String(response.statusCode)));
        request.on("upgrade", () => resolve("upgraded"));
        request.on("error", reject);
        request.end();
      });
      assert.equal(upgrade, "403");
      assert.equal(proxy.stats.wsOpened, 0);
    } finally {
      await proxy.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("which daemons the matrix runs", () => {
  it("compares versions by number", () => {
    assert.equal(compareVersions("0.0.113", "0.0.99"), 1);
    assert.equal(compareVersions("0.0.118", "0.0.118"), 0);
    assert.equal(compareVersions("0.0.9", "0.1.0"), -1);
  });

  it("reads published versions from SHA256SUMS, skipping the latest alias", () => {
    const sha = "a".repeat(64);
    const sums = parseReleaseSums(
      [
        `${sha}  uno-work-server-0.0.118.tar.gz`,
        `${sha}  uno-work-server-latest.tar.gz`,
        `${sha} *uno-work-server-0.0.119.tar.gz`,
        `${sha}  lite.tgz`,
        "",
      ].join("\n"),
    );
    assert.deepStrictEqual([...sums.keys()], ["0.0.118", "0.0.119"]);
  });

  it("defaults to this checkout, the two newest releases not newer than it, and the floor", () => {
    const published = ["0.0.113", "0.0.114", "0.0.116", "0.0.117", "0.0.118", "0.0.119"];
    // A release branch: N-1 and N-2.
    assert.deepStrictEqual(
      defaultDaemonSpecs({ branchVersion: "0.0.120", published, floor: "0.0.113" }),
      ["current", "0.0.119", "0.0.118", "0.0.113"],
    );
    // A branch whose number is already published: that build is the nearest older daemon.
    assert.deepStrictEqual(
      defaultDaemonSpecs({ branchVersion: "0.0.119", published, floor: "0.0.113" }),
      ["current", "0.0.119", "0.0.118", "0.0.113"],
    );
    // Close to the floor: no duplicates, nothing below it.
    assert.deepStrictEqual(
      defaultDaemonSpecs({ branchVersion: "0.0.114", published, floor: "0.0.113" }),
      ["current", "0.0.114", "0.0.113"],
    );
  });

  it("parses an explicit list and stops on a typo", () => {
    assert.deepStrictEqual(parseDaemonSpecs("current, v0.0.118,0.0.113 0.0.118"), [
      "current",
      "0.0.118",
      "0.0.113",
    ]);
    assert.throws(() => parseDaemonSpecs("current,latest"));
  });

  it("finds RPC methods a daemon bundle does not have", () => {
    const dir = mkdtempSync(join(tmpdir(), "compat-bundle-test-"));
    try {
      writeFileSync(join(dir, "bin.mjs"), 'const m = { a: "projects.list", b: `files.list` };');
      writeFileSync(join(dir, "chunk.mjs"), "const n = 'server.getConfig';");
      assert.deepStrictEqual(
        rpcMethodsMissingFromBundle(dir, [
          "projects.list",
          "files.list",
          "server.getConfig",
          "uno.future",
        ]),
        ["uno.future"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what counts as a finding", () => {
  it("recognises a program talking instead of Uno Work", () => {
    assert.isNull(findRawError("You were signed out of Claude. Sign in again."));
    assert.include(
      findRawError(
        "Error: Internal error at decode (file:///opt/app/node_modules/effect/x.js:796:17)",
      ) ?? "",
      "a stack trace",
    );
    assert.include(findRawError("Could not load [object Object]") ?? "", "[object Object]");
    assert.include(findRawError('Expected "a" | "b", got "c"') ?? "", "schema");
  });

  it("judges the turn after a message on a stand with no model", () => {
    const signedOut = judgeTurnOutcome({
      notices: ["You were signed out of Hermes\nSign in again in Settings to continue."],
      chatAfterMessage: "WORK LOG (1)\nProvider turn start failed - Error at x (file:///a.js:1:2)",
    });
    assert.isTrue(signedOut.ok);
    assert.include(signedOut.reason, "You were signed out of Hermes / Sign in again");
    assert.lengthOf(signedOut.notes, 1);

    // The daemon's own work log line and nothing else: the stand, not a version gap.
    const workLogOnly = judgeTurnOutcome({
      notices: [],
      chatAfterMessage: "Provider turn start failed - Error at x (file:///a.js:1:2)",
    });
    assert.isTrue(workLogOnly.ok);
    assert.lengthOf(workLogOnly.notes, 1);

    assert.isTrue(judgeTurnOutcome({ notices: [], chatAfterMessage: "" }).ok);

    // A stack trace presented as a notice is the interface's fault.
    assert.isFalse(
      judgeTurnOutcome({ notices: ["Failed at run (file:///a.js:1:2)"], chatAfterMessage: "" }).ok,
    );
  });

  it("explains away only what the stand itself causes", () => {
    const problems = [
      { method: "HEAD", path: "/office-engine/vendor/api.js", status: 404, contentType: "" },
      { method: "GET", path: "/api/self-update/status", status: 404, contentType: "" },
      { method: "GET", path: "/api/new-thing", status: 200, contentType: "text/html" },
    ];
    assert.deepStrictEqual(
      unexplainedMachineProblems(problems).map((problem) => problem.path),
      ["/api/self-update/status", "/api/new-thing"],
    );
  });

  it("reads RPC frames: methods sent, crashes, refusals, and what the page had cancelled", () => {
    const traffic = emptyRpcTraffic();
    const socket = emptyRpcSocketState();
    const send = (frame: unknown) => recordRpcFrame(traffic, socket, "sent", JSON.stringify(frame));
    const receive = (frame: unknown) =>
      recordRpcFrame(traffic, socket, "received", JSON.stringify(frame));
    const die = (requestId: string, defect: string) =>
      receive({
        _tag: "Exit",
        requestId,
        exit: { _tag: "Failure", cause: [{ _tag: "Die", defect }] },
      });

    send({ _tag: "Request", id: "1", tag: "subscribeVcsStatus", payload: {} });
    send({ _tag: "Request", id: "2", tag: "orchestration.dispatchCommand", payload: {} });
    send({ _tag: "Request", id: "3", tag: "orchestration.dispatchCommand", payload: {} });
    send({ _tag: "Request", id: "4", tag: "uno.cloud.getState", payload: {} });
    send({ _tag: "Ping" });
    assert.deepStrictEqual([...traffic.sent].toSorted(), [
      "orchestration.dispatchCommand",
      "subscribeVcsStatus",
      "uno.cloud.getState",
    ]);

    // The page left the screen, then the daemon failed on that subscription.
    send({ _tag: "Interrupt", requestId: "1" });
    die("1", "Expected GitManagerError, got Done");
    // An old daemon dies on a command type it does not know.
    die("2", 'Expected { "type": "project.create" } | …');
    // A daemon with day 1 refuses it in words.
    receive({
      _tag: "Exit",
      requestId: "3",
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: { _tag: "OrchestrationDispatchCommandError", message: "isn't supported" },
          },
        ],
      },
    });
    // Its own, ordinary error.
    receive({
      _tag: "Exit",
      requestId: "4",
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "not signed in" } }] },
    });
    // An interrupted request is not a failure at all.
    receive({
      _tag: "Exit",
      requestId: "4",
      exit: { _tag: "Failure", cause: [{ _tag: "Interrupt" }] },
    });
    // An unknown method: the daemon answers for the whole connection.
    receive({ _tag: "Defect", defect: "Unknown request tag: uno.future.method" });
    recordRpcFrame(traffic, socket, "received", "not json");

    assert.deepStrictEqual(traffic.defectsAfterCancel, [
      "subscribeVcsStatus: Expected GitManagerError, got Done",
    ]);
    assert.lengthOf(traffic.defects, 2);
    assert.include(traffic.defects[0] ?? "", "orchestration.dispatchCommand: Expected");
    assert.include(traffic.defects[1] ?? "", "Unknown request tag: uno.future.method");
    assert.deepStrictEqual(refusedCommands(traffic), [
      "orchestration.dispatchCommand: OrchestrationDispatchCommandError: isn't supported",
    ]);
    assert.lengthOf(traffic.refusals, 2);
  });

  it("finds /api routes of the web build and which a daemon bundle lacks", () => {
    const dir = mkdtempSync(join(tmpdir(), "compat-routes-test-"));
    try {
      mkdirSync(join(dir, "web", "assets"), { recursive: true });
      mkdirSync(join(dir, "daemon"));
      writeFileSync(
        join(dir, "web", "assets", "main-1.js"),
        'fetch("/api/files/list");fetch(`/api/self-update/status`);fetch("/api/v1/account/goal");x="/assets/a.js"',
      );
      writeFileSync(join(dir, "web", "assets", "main-1.css"), 'a{b:"/api/not-code"}');
      writeFileSync(join(dir, "daemon", "bin.mjs"), 'route("/api/files/list")');
      const routes = apiRoutesOfWebBuild(join(dir, "web"));
      assert.deepStrictEqual(routes, [
        "/api/files/list",
        "/api/self-update/status",
        "/api/v1/account/goal",
      ]);
      assert.deepStrictEqual(apiRoutesMissingFromBundle(join(dir, "daemon"), routes), [
        "/api/self-update/status",
        "/api/v1/account/goal",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets a missing route pass only behind a feature the daemon does not claim", () => {
    const featureRoutes = [{ prefix: "/api/self-update/", feature: "self-update" }];
    const missing = ["/api/self-update/status", "/api/brand-new"];
    assert.deepStrictEqual(
      judgeHttpRoutes({ missing, featureRoutes, daemonSupports: () => false }),
      { ungated: ["/api/brand-new"], gated: ["/api/self-update/status (self-update)"] },
    );
    // The daemon says it has the feature and still lacks the route: not hidden from anyone.
    assert.deepStrictEqual(
      judgeHttpRoutes({ missing, featureRoutes, daemonSupports: () => true }).ungated,
      missing,
    );
  });

  it("fails on an RPC method the daemon lacks unless it is behind a capability and unused", () => {
    const sent = new Set(["server.getConfig"]);
    assert.isTrue(judgeRpcMethods({ methodCount: 3, missing: [], sent }).ok);
    const ungated = judgeRpcMethods({ methodCount: 3, missing: ["uno.future"], sent });
    assert.isFalse(ungated.ok);
    assert.include(ungated.reason, "uno.future");
    const gated = { "uno.future": "futureThing" };
    assert.isTrue(judgeRpcMethods({ methodCount: 3, missing: ["uno.future"], sent, gated }).ok);
    const sentAnyway = judgeRpcMethods({
      methodCount: 3,
      missing: ["uno.future"],
      sent: new Set(["uno.future"]),
      gated,
    });
    assert.isFalse(sentAnyway.ok);
    assert.include(sentAnyway.reason, "the connection ends");
  });
});

describe("the report", () => {
  it("is a table with one row per daemon, reasons for every ❌ and notes", () => {
    const green = {} as SmokeResults;
    for (const { id } of CHECKS) green[id] = { status: "pass", reason: `${id} fine`, notes: [] };
    const red = { ...green, send: failed("the computer refused a command") };
    green.degrade = { status: "pass", reason: "all answered", notes: ["a rough spot"] };
    const report = formatMatrix({
      webVersion: "0.0.120",
      commit: "abc1234",
      seconds: 200,
      columns: [
        { name: "current", version: "0.0.120", isCurrent: true, results: green },
        { name: "0.0.113", version: "0.0.113", isCurrent: false, results: red },
      ],
    });
    assert.include(report, "| current (0.0.120) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |");
    assert.include(report, "| 0.0.113 | ✅ | ✅ | ❌ | ✅ |");
    assert.include(report, "- 0.0.113 · New chat + message: the computer refused a command");
    assert.include(report, "note: a rough spot");
  });
});
