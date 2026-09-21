import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { UnoBoxIdentity } from "../unoBoxIdentity.ts";
import { ControlPlaneHttpError } from "./unoCloudParse.ts";
import { UnoComputerService, makeUnoComputerService } from "./UnoComputerService.ts";

function serviceLayer(input: {
  readonly apiKey: string;
  readonly boxToken?: string;
  readonly ownBoxId: number | null;
  readonly routes: Record<string, () => unknown>;
  readonly calls?: string[];
  readonly keys?: string[];
}) {
  const fetchJson = async (apiKey: string, path: string) => {
    input.calls?.push(path);
    input.keys?.push(apiKey);
    const route = input.routes[path.split("?")[0] ?? path];
    if (!route) throw new ControlPlaneHttpError(404, "404: 404 page not found");
    return route();
  };
  return Layer.effect(UnoComputerService, makeUnoComputerService({ fetchJson })).pipe(
    Layer.provide(
      ServerSettingsService.layerTest({
        uno: {
          apiKey: input.apiKey,
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

it.effect("reads this machine's computer by its own box id", () =>
  Effect.gen(function* () {
    const computer = yield* UnoComputerService;
    const state = yield* computer.getState();
    assert.strictEqual(state.own, true);
    assert.strictEqual(state.box?.name, "work");
  }).pipe(
    Effect.provide(
      serviceLayer({
        apiKey: "key",
        ownBoxId: 42,
        routes: { "/api/v1/boxes/42": () => ({ id: 42, name: "work", status: "running" }) },
      }),
    ),
  ),
);

it.effect("answers 'not linked' without touching the control plane when there is no key", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const computer = yield* UnoComputerService;
    const state = yield* computer.getState();
    const metrics = yield* computer.metrics();
    assert.strictEqual(state.linked, false);
    assert.strictEqual(metrics.availability, "error");
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(serviceLayer({ apiKey: "", ownBoxId: 42, routes: {}, calls })));
});

it.effect("degrades to 'coming soon' when the backend has not shipped the routes", () =>
  Effect.gen(function* () {
    const computer = yield* UnoComputerService;
    const metrics = yield* computer.metrics();
    const activity = yield* computer.activity();
    const apps = yield* computer.apps();
    assert.strictEqual(metrics.availability, "unavailable");
    assert.strictEqual(activity.availability, "unavailable");
    assert.strictEqual(apps.catalog.availability, "unavailable");
  }).pipe(Effect.provide(serviceLayer({ apiKey: "key", ownBoxId: 42, routes: {} }))),
);

it.effect("remembers an install so the app list shows it before the service list does", () =>
  Effect.gen(function* () {
    const computer = yield* UnoComputerService;
    const started = yield* computer.installApp({ templateId: "uptime-kuma" });
    assert.strictEqual(started.deploymentId, 500);
    const apps = yield* computer.apps();
    assert.deepStrictEqual(
      apps.installed.apps.map((app) => [app.name, app.state]),
      [["Uptime Kuma", "installing"]],
    );
    const status = yield* computer.installStatus({ deploymentId: 500 });
    assert.strictEqual(status.state, "running");
    const after = yield* computer.apps();
    assert.strictEqual(after.installed.apps[0]?.state, "running");
  }).pipe(
    Effect.provide(
      serviceLayer({
        apiKey: "key",
        ownBoxId: 42,
        routes: {
          "/api/v1/boxes/42/apps": () => ({ deployment_id: 500, status: "queued" }),
          "/api/v1/apps/templates": () => ({
            templates: [{ id: "uptime-kuma", name: "Uptime Kuma", icon: "📈" }],
          }),
          "/api/v1/git/services": () => ({ services: [] }),
          "/api/v1/deployments/500/logs": () => ({ status: "success", done: true, logs: [] }),
        },
      }),
    ),
  ),
);

it.effect("fails an install with a readable message when there is no computer", () =>
  Effect.gen(function* () {
    const computer = yield* UnoComputerService;
    const error = yield* computer.installApp({ templateId: "n8n" }).pipe(Effect.flip);
    assert.match(error.message, /isn't an Uno computer/);
  }).pipe(Effect.provide(serviceLayer({ apiKey: "key", ownBoxId: null, routes: {} }))),
);

it.effect("a work machine reads its own computer with the box token, not the AI key", () => {
  const keys: string[] = [];
  return Effect.gen(function* () {
    const computer = yield* UnoComputerService;
    const state = yield* computer.getState();
    assert.strictEqual(state.own, true);
    assert.strictEqual(state.error, null);
    assert.ok(keys.length > 0);
    assert.ok(keys.every((key) => key === "uno_agt_box"));
  }).pipe(
    Effect.provide(
      serviceLayer({
        apiKey: "unollm_ai",
        boxToken: "uno_agt_box",
        ownBoxId: 1806,
        routes: {
          "/api/v1/boxes/1806": () => ({ id: 1806, name: "stage-work", status: "running" }),
        },
        keys,
      }),
    ),
  );
});

it.effect("with only the AI key the screen says 'not linked' instead of a 401", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const computer = yield* UnoComputerService;
    const state = yield* computer.getState();
    assert.strictEqual(state.linked, false);
    assert.strictEqual(state.error, null);
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(serviceLayer({ apiKey: "unollm_ai", ownBoxId: 1806, routes: {}, calls })));
});

it.effect("another box of the account never gets the box token", () => {
  const keys: string[] = [];
  return Effect.gen(function* () {
    const computer = yield* UnoComputerService;
    yield* computer.getState({ boxId: 7 });
    assert.ok(keys.every((key) => key === "uno_usr_account"));
  }).pipe(
    Effect.provide(
      serviceLayer({
        apiKey: "uno_usr_account",
        boxToken: "uno_agt_box",
        ownBoxId: 1806,
        routes: { "/api/v1/boxes/7": () => ({ id: 7, name: "other", status: "running" }) },
        keys,
      }),
    ),
  );
});

it.effect("powers its own box with the box token and leaves other boxes to the account key", () => {
  const calls: string[] = [];
  return Effect.gen(function* () {
    const computer = yield* UnoComputerService;
    assert.strictEqual(yield* computer.powerOwnBox(1806, "stop"), true);
    assert.strictEqual(yield* computer.powerOwnBox(7, "stop"), false);
    assert.deepStrictEqual(calls, ["/api/v1/boxes/1806/stop"]);
  }).pipe(
    Effect.provide(
      serviceLayer({
        apiKey: "unollm_ai",
        boxToken: "uno_agt_box",
        ownBoxId: 1806,
        routes: { "/api/v1/boxes/1806/stop": () => ({ ok: true }) },
        calls,
      }),
    ),
  );
});
