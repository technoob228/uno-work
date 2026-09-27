import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { pluginPanelRouteLayer } from "./http.ts";
import {
  PANEL_TOKEN_LOAD_WINDOW_MS,
  PANEL_TOKEN_SESSION_MS,
  signPanelToken,
  verifyPanelTokenSignature,
} from "./panelTokens.ts";
import { PluginRegistry, type LoadedPlugin } from "./PluginRegistry.ts";

const SECRET = new Uint8Array(32).fill(7);
const PANEL_PATH = "panel/index.html";

const registryLayer = (plugins: ReadonlyArray<LoadedPlugin>) =>
  Layer.mock(PluginRegistry)({
    start: Effect.void,
    ready: Effect.void,
    getLoadedPlugins: Effect.succeed(plugins),
    verifyPanelToken: ({ pluginId, panelPath, token }) =>
      Effect.sync(() => verifyPanelTokenSignature({ secret: SECRET, pluginId, panelPath, token })),
    recordRun: () => Effect.void,
    streamChanges: Stream.empty,
  });

const mint = (pluginId: string, ageMs = 0, secret = SECRET) =>
  signPanelToken({ secret, pluginId, panelPath: PANEL_PATH, issuedAtMs: Date.now() - ageMs });

const manifest = (overrides: Partial<LoadedPlugin["manifest"] & object> = {}) =>
  ({
    name: "Demo",
    enabled: true,
    hooks: [],
    crons: [],
    ...overrides,
  }) as NonNullable<LoadedPlugin["manifest"]>;

/**
 * Собирает временную директорию плагинов и web-handler ровно с панельным
 * роутом — без остального сервера.
 */
const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-panel-test-" });
  const pluginDir = path.join(baseDir, "plugins", "demo");
  yield* fs.makeDirectory(path.join(pluginDir, "panel"), { recursive: true });
  yield* fs.writeFileString(path.join(pluginDir, "plugin.json"), `{"name":"Demo"}`);
  yield* fs.writeFileString(path.join(pluginDir, "secret-at-plugin-root.txt"), "plugin secret");
  yield* fs.writeFileString(path.join(pluginDir, "panel", "index.html"), "<h1>panel</h1>");
  yield* fs.writeFileString(path.join(pluginDir, "panel", "data.json"), `{"ok":true}`);
  yield* fs.writeFileString(path.join(baseDir, "outside.txt"), "outside secret");
  // Симлинк из панельной папки наружу: текстовая проверка путей его пропускает,
  // ловить обязана realpath-проверка.
  yield* fs.symlink(path.join(baseDir, "outside.txt"), path.join(pluginDir, "panel", "leak.txt"));

  const plugins: ReadonlyArray<LoadedPlugin> = [
    {
      id: "demo",
      fileName: "demo/plugin.json",
      filePath: path.join(pluginDir, "plugin.json"),
      directoryPath: pluginDir,
      manifest: manifest({ panel: { title: "Demo", path: "panel/index.html" } }),
      error: undefined,
      approval: "approved",
    },
    {
      id: "off",
      fileName: "off/plugin.json",
      filePath: path.join(pluginDir, "plugin.json"),
      directoryPath: pluginDir,
      manifest: manifest({
        enabled: false,
        panel: { title: "Off", path: "panel/index.html" },
      }),
      error: undefined,
      approval: "approved",
    },
    {
      id: "no-panel",
      fileName: "no-panel.json",
      filePath: path.join(pluginDir, "plugin.json"),
      directoryPath: undefined,
      manifest: manifest(),
      error: undefined,
      approval: "approved",
    },
  ];

  // Зависимости роута — фантомные Requires, они выходят наружу как контекст
  // самого handler'а, поэтому собираем их слои отдельно и передаём вызовом.
  const context = yield* Layer.build(Layer.mergeAll(registryLayer(plugins), NodeServices.layer));
  const { handler, dispose } = HttpRouter.toWebHandler(pluginPanelRouteLayer, {
    disableLogger: true,
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));

  const get = (pathAndQuery: string, headers: Record<string, string> = {}) =>
    Effect.promise(() =>
      handler(new Request(`http://127.0.0.1${pathAndQuery}`, { headers }), context),
    );

  return { get, baseDir };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("plugin panel route", (it) => {
  it.effect("serves the manifest entry and sibling assets with MIME and hardening headers", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;
      const token = mint("demo");

      const entry = yield* get(`/api/plugins/demo/panel/${token}/`);
      assert.equal(entry.status, 200);
      assert.include(entry.headers.get("content-type") ?? "", "text/html");
      assert.equal(entry.headers.get("x-content-type-options"), "nosniff");
      assert.equal(entry.headers.get("cache-control"), "no-cache");
      const csp = entry.headers.get("content-security-policy") ?? "";
      assert.include(csp, "default-src 'self'");
      assert.include(csp, "sandbox allow-scripts");
      assert.notInclude(csp, "allow-same-origin");
      assert.equal(yield* Effect.promise(() => entry.text()), "<h1>panel</h1>");

      // Relative sub-resources resolve under the same tokenised prefix.
      const data = yield* get(`/api/plugins/demo/panel/${token}/data.json`, {
        "sec-fetch-dest": "empty",
      });
      assert.equal(data.status, 200);
      assert.include(data.headers.get("content-type") ?? "", "application/json");
      assert.equal(yield* Effect.promise(() => data.text()), `{"ok":true}`);
    }).pipe(Effect.scoped),
  );

  it.effect("requires a valid token for every request, whatever Sec-Fetch-Dest says", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;

      for (const dest of ["iframe", "document", "empty", "script", ""]) {
        const headers: Record<string, string> = dest ? { "sec-fetch-dest": dest } : {};
        assert.equal((yield* get("/api/plugins/demo/panel/", headers)).status, 401);
        assert.equal((yield* get("/api/plugins/demo/panel/data.json", headers)).status, 401);
      }

      const forged = mint("demo", 0, new Uint8Array(32).fill(9));
      assert.equal((yield* get(`/api/plugins/demo/panel/${forged}/data.json`)).status, 401);

      // A token for another plugin does not open this one.
      const foreign = mint("off");
      assert.equal((yield* get(`/api/plugins/demo/panel/${foreign}/data.json`)).status, 401);

      const tampered = `${mint("demo").slice(0, -2)}AA`;
      assert.equal((yield* get(`/api/plugins/demo/panel/${tampered}/data.json`)).status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect("the entry document needs a fresh token, assets live for the panel session", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;

      const loaded = mint("demo", PANEL_TOKEN_LOAD_WINDOW_MS + 60_000);
      assert.equal((yield* get(`/api/plugins/demo/panel/${loaded}/`)).status, 401);
      assert.equal((yield* get(`/api/plugins/demo/panel/${loaded}/index.html`)).status, 401);
      assert.equal((yield* get(`/api/plugins/demo/panel/${loaded}/data.json`)).status, 200);

      const expired = mint("demo", PANEL_TOKEN_SESSION_MS + 60_000);
      assert.equal((yield* get(`/api/plugins/demo/panel/${expired}/data.json`)).status, 401);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects traversal out of the panel directory", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;
      const token = mint("demo");

      for (const candidate of [
        `/api/plugins/demo/panel/${token}/..%2f..%2foutside.txt`,
        `/api/plugins/demo/panel/${token}/%2e%2e%2f%2e%2e%2foutside.txt`,
        `/api/plugins/demo/panel/${token}/..%2fsecret-at-plugin-root.txt`,
        `/api/plugins/demo/panel/${token}/%2e%2e/secret-at-plugin-root.txt`,
        `/api/plugins/demo/panel/${token}//etc/passwd`,
        `/api/plugins/demo/panel/${token}/%2fetc%2fpasswd`,
        `/api/plugins/..%2f..%2fetc/panel/${token}/passwd`,
      ]) {
        const response = yield* get(candidate);
        assert.include(
          [400, 401, 404],
          response.status,
          `${candidate} must not be served (got ${response.status})`,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a symlink that escapes the plugin directory", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;
      const response = yield* get(`/api/plugins/demo/panel/${mint("demo")}/leak.txt`);
      assert.include([400, 404], response.status);
    }).pipe(Effect.scoped),
  );

  it.effect("hides disabled plugins, panel-less plugins and unknown ids", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;

      assert.equal((yield* get(`/api/plugins/off/panel/${mint("off")}/`)).status, 404);
      assert.equal((yield* get(`/api/plugins/off/panel/${mint("off")}/data.json`)).status, 404);
      // No panel / unknown id: indistinguishable from a bad token.
      assert.equal((yield* get(`/api/plugins/no-panel/panel/${mint("no-panel")}/`)).status, 401);
      assert.equal((yield* get(`/api/plugins/nope/panel/${mint("nope")}/`)).status, 401);
    }).pipe(Effect.scoped),
  );
});
