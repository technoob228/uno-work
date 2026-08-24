import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { AuthError, ServerAuth, type AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { pluginPanelRouteLayer } from "./http.ts";
import { PluginRegistry, type LoadedPlugin } from "./PluginRegistry.ts";

const AUTH_HEADER = "x-test-session";

const testSession = {
  sessionId: "test-session",
  subject: "test",
  method: "cookie",
  role: "owner",
} as unknown as AuthenticatedSession;

const authLayer = Layer.mock(ServerAuth)({
  authenticateHttpRequest: (request) =>
    request.headers[AUTH_HEADER] === "yes"
      ? Effect.succeed(testSession)
      : Effect.fail(new AuthError({ message: "Unauthorized", status: 401 })),
});

const registryLayer = (plugins: ReadonlyArray<LoadedPlugin>) =>
  Layer.mock(PluginRegistry)({
    start: Effect.void,
    ready: Effect.void,
    getLoadedPlugins: Effect.succeed(plugins),
    recordRun: () => Effect.void,
    streamChanges: Stream.empty,
  });

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

  const plugins: ReadonlyArray<LoadedPlugin> = [
    {
      id: "demo",
      fileName: "demo/plugin.json",
      filePath: path.join(pluginDir, "plugin.json"),
      directoryPath: pluginDir,
      manifest: manifest({ panel: { title: "Demo", path: "panel/index.html" } }),
      error: undefined,
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
    },
    {
      id: "no-panel",
      fileName: "no-panel.json",
      filePath: path.join(pluginDir, "plugin.json"),
      directoryPath: undefined,
      manifest: manifest(),
      error: undefined,
    },
  ];

  // Зависимости роута — фантомные Requires, они выходят наружу как контекст
  // самого handler'а, поэтому собираем их слои отдельно и передаём вызовом.
  const context = yield* Layer.build(
    Layer.mergeAll(authLayer, registryLayer(plugins), NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(pluginPanelRouteLayer, {
    disableLogger: true,
  });
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));

  const get = (
    pathAndQuery: string,
    headers: Record<string, string> = { [AUTH_HEADER]: "yes", "sec-fetch-dest": "iframe" },
  ) =>
    Effect.promise(() =>
      handler(new Request(`http://127.0.0.1${pathAndQuery}`, { headers }), context),
    );

  return { get, baseDir };
});

it.layer(NodeServices.layer, { excludeTestServices: true })("plugin panel route", (it) => {
  it.effect("serves the manifest entry and sibling assets with MIME and hardening headers", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;

      const entry = yield* get("/api/plugins/demo/panel/");
      assert.equal(entry.status, 200);
      assert.include(entry.headers.get("content-type") ?? "", "text/html");
      assert.equal(entry.headers.get("x-content-type-options"), "nosniff");
      assert.equal(entry.headers.get("cache-control"), "no-cache");
      assert.include(entry.headers.get("content-security-policy") ?? "", "default-src 'self'");
      assert.equal(yield* Effect.promise(() => entry.text()), "<h1>panel</h1>");

      const data = yield* get("/api/plugins/demo/panel/data.json", {
        "sec-fetch-dest": "empty",
      });
      assert.equal(data.status, 200);
      assert.include(data.headers.get("content-type") ?? "", "application/json");
      assert.equal(yield* Effect.promise(() => data.text()), `{"ok":true}`);
    }).pipe(Effect.scoped),
  );

  it.effect("requires a session for navigation but not for subresources", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;

      const iframeNoAuth = yield* get("/api/plugins/demo/panel/", { "sec-fetch-dest": "iframe" });
      assert.equal(iframeNoAuth.status, 401);

      // Без Sec-Fetch-Dest (curl и прочие не-браузеры) — считаем навигацией.
      const bareNoAuth = yield* get("/api/plugins/demo/panel/", {});
      assert.equal(bareNoAuth.status, 401);

      const subresourceNoAuth = yield* get("/api/plugins/demo/panel/data.json", {
        "sec-fetch-dest": "empty",
      });
      assert.equal(subresourceNoAuth.status, 200);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects traversal out of the panel directory", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;

      for (const candidate of [
        "/api/plugins/demo/panel/..%2f..%2foutside.txt",
        "/api/plugins/demo/panel/%2e%2e%2f%2e%2e%2foutside.txt",
        "/api/plugins/demo/panel/..%2fsecret-at-plugin-root.txt",
        "/api/plugins/demo/panel/%2e%2e/secret-at-plugin-root.txt",
        "/api/plugins/demo/panel//etc/passwd",
        "/api/plugins/demo/panel/%2fetc%2fpasswd",
        "/api/plugins/..%2f..%2fetc/panel/passwd",
      ]) {
        const response = yield* get(candidate);
        assert.include(
          [400, 404],
          response.status,
          `${candidate} must not be served (got ${response.status})`,
        );
      }
    }).pipe(Effect.scoped),
  );

  it.effect("hides disabled plugins, panel-less plugins and unknown ids", () =>
    Effect.gen(function* () {
      const { get } = yield* makeFixture;

      assert.equal((yield* get("/api/plugins/off/panel/")).status, 404);
      assert.equal((yield* get("/api/plugins/off/panel/data.json")).status, 404);
      assert.equal((yield* get("/api/plugins/no-panel/panel/")).status, 404);
      assert.equal((yield* get("/api/plugins/nope/panel/")).status, 404);
    }).pipe(Effect.scoped),
  );
});
