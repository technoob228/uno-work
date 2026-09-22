import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoBoxIdentity } from "../unoBoxIdentity.ts";
import { ControlPlaneHttpError } from "../workspaceRegistry/unoCloudParse.ts";
import {
  MachineAppsService,
  PUBLISH_NOT_A_COMPUTER,
  appEnvironment,
  makeMachineAppsService,
} from "./MachineAppsService.ts";
import type { MachineProbe } from "./machineAppsScan.ts";

const SS = `LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1234,fd=21))
LISTEN 0 511 127.0.0.1:8787 0.0.0.0:* users:(("python3",pid=77,fd=5))
LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=612,fd=3))
`;

const probe: Partial<MachineProbe> = {
  platform: "linux",
  run: async (command) => (command === "ss" ? { ok: true, stdout: SS } : { ok: false, stdout: "" }),
  readFile: async () => null,
  probeHttp: async () => ({ http: true, title: null }),
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly key: string;
}

function serviceLayer(input: {
  readonly ownBoxId: number | null;
  readonly apiKey?: string;
  readonly boxToken?: string;
  readonly ports?: unknown[];
  readonly calls?: Call[];
}) {
  const ports = [...(input.ports ?? [])] as Array<Record<string, unknown>>;
  const fetchJson = async (key: string, path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    input.calls?.push({ method, path, body, key });
    if (path === "/api/v1/boxes/42" && method === "GET") {
      return { id: 42, hostname: "work.u85.uno4.me" };
    }
    if (path === "/api/v1/boxes/42/ports" && method === "GET") return { ports };
    if (path === "/api/v1/boxes/42/ports" && method === "POST") {
      const forward = {
        id: 100 + ports.length,
        internal_port: body.port,
        external_port: 43000,
        protocol: "tcp",
        visibility: "public",
        state: "applied",
      };
      ports.push(forward);
      return forward;
    }
    const del = /^\/api\/v1\/boxes\/42\/ports\/(\d+)$/.exec(path);
    if (del && method === "DELETE") {
      const index = ports.findIndex((p) => p["id"] === Number(del[1]));
      if (index !== -1) ports.splice(index, 1);
      return { status: "deleted" };
    }
    throw new ControlPlaneHttpError(404, "404: not found");
  };
  return Layer.effect(
    MachineAppsService,
    makeMachineAppsService({
      probe,
      fetchJson,
      home: "/home/unowork",
      manifestDir: "/nonexistent/uno-apps",
      background: false,
    }),
  ).pipe(
    Layer.provide(Layer.succeed(ServerConfig, { port: 80 } as ServerConfigShape)),
    Layer.provide(
      ServerSettingsService.layerTest({
        uno: {
          apiKey: input.apiKey ?? "unollm_gateway_key",
          ...(input.boxToken !== undefined ? { boxToken: input.boxToken } : {}),
        },
      }),
    ),
    Layer.provide(
      Layer.succeed(UnoBoxIdentity, {
        current: Effect.succeed(input.ownBoxId),
        probe: Effect.void,
      }),
    ),
  );
}

it.effect("lists programs and shows an app's public address once its port is published", () =>
  Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const listed = yield* service.list;
    assert.deepStrictEqual(
      listed.apps.map((a) => a.id),
      ["port:3000", "port:8787"],
    );
    assert.strictEqual(listed.publishBlockedReason, null);
    const app = listed.apps.find((a) => a.id === "port:3000");
    assert.deepStrictEqual(app?.publication, {
      forwardId: 7,
      externalPort: 43007,
      url: "http://work.u85.uno4.me:43007/",
      state: "applied",
    });
  }).pipe(
    Effect.provide(
      serviceLayer({
        ownBoxId: 42,
        boxToken: "uno_agt_machine",
        ports: [
          { id: 7, internal_port: 3000, external_port: 43007, protocol: "tcp", visibility: "public", state: "applied" },
        ],
      }),
    ),
  ),
);

it.effect("publishes with the machine's own token and hides again", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const published = yield* service.action({ appId: "port:3000", action: "publish" });
    const post = calls.find((c) => c.method === "POST");
    assert.deepStrictEqual(post?.body, { port: 3000, protocol: "tcp", visibility: "public" });
    assert.strictEqual(post?.key, "uno_agt_machine");
    const app = published.apps.find((a) => a.id === "port:3000");
    assert.strictEqual(app?.publication?.url, "http://work.u85.uno4.me:43000/");

    const hidden = yield* service.action({ appId: "port:3000", action: "unpublish" });
    assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/boxes/42/ports/100"));
    assert.strictEqual(hidden.apps.find((a) => a.id === "port:3000")?.publication, null);
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: 42, boxToken: "uno_agt_machine", calls })));
});

it.effect("refuses to publish an app that only listens on 127.0.0.1", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const exit = yield* Effect.exit(service.action({ appId: "port:8787", action: "publish" }));
    assert.ok(Exit.isFailure(exit));
    assert.ok(String(JSON.stringify(exit)).includes("127.0.0.1"));
    assert.ok(!calls.some((c) => c.method === "POST"));
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: 42, boxToken: "uno_agt_machine", calls })));
});

it.effect("never acts on an id the scan did not find", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    for (const appId of ["port:22", "port:80", "docker:../../etc", "systemd:ssh.service"]) {
      const exit = yield* Effect.exit(service.action({ appId, action: "unpublish" }));
      assert.ok(Exit.isFailure(exit), appId);
    }
    assert.ok(!calls.some((c) => c.method === "DELETE" || c.method === "POST"));
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: 42, boxToken: "uno_agt_machine", calls })));
});

it.effect("says why publishing can't work on a laptop, without calling the cloud", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const listed = yield* service.list;
    assert.strictEqual(listed.publishBlockedReason, PUBLISH_NOT_A_COMPUTER);
    const exit = yield* Effect.exit(service.action({ appId: "port:3000", action: "publish" }));
    assert.ok(Exit.isFailure(exit));
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: null, calls })));
});

it.effect("does not send the gateway key to the console", () => {
  const calls: Call[] = [];
  return Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const listed = yield* service.list;
    assert.ok(listed.publishBlockedReason !== null);
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: 42, apiKey: "unollm_x", calls })));
});

it.effect("reads live load of this machine", () =>
  Effect.gen(function* () {
    const service = yield* MachineAppsService;
    const metrics = yield* service.localMetrics;
    assert.ok(metrics.memTotalMb > 0);
    assert.ok(metrics.cpuCount > 0);
    assert.ok(metrics.cpuPct === null || (metrics.cpuPct >= 0 && metrics.cpuPct <= 100));
  }).pipe(Effect.provide(serviceLayer({ ownBoxId: null }))),
);

it("starts apps with a clean environment, not the daemon's", () => {
  process.env["UNO_SECRET_FOR_TEST"] = "leak";
  const env = appEnvironment("/home/unowork", 3000);
  delete process.env["UNO_SECRET_FOR_TEST"];
  assert.strictEqual(env["PORT"], "3000");
  assert.strictEqual(env["HOME"], "/home/unowork");
  assert.strictEqual(env["UNO_SECRET_FOR_TEST"], undefined);
});
