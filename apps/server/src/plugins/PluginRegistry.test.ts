import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../config.ts";
import {
  makePluginRegistryLive,
  PluginRegistry,
  type PluginRegistryShape,
} from "./PluginRegistry.ts";

const makePluginRegistryLayer = () =>
  // Быстрый страховочный свип: watch-тесты не должны зависеть от того, успел
  // ли fs.watch форкнутого стрима встать до первой записи файла.
  makePluginRegistryLive({ sweepIntervalMs: 300 }).pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-plugin-registry-test-",
        }),
      ),
    ),
  );

const writePlugin = (fileName: string, contents: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { pluginsDir } = yield* ServerConfig;
    const filePath = path.join(pluginsDir, fileName);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(
      filePath,
      typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
    );
  });

it.layer(NodeServices.layer)("plugin registry", (it) => {
  it.effect("loads manifests, defaults enabled, and surfaces invalid files", () =>
    Effect.gen(function* () {
      yield* writePlugin("notify.json", {
        name: "Notify",
        description: "Notify on turn completion",
        hooks: [{ on: "thread.turn-diff-completed", run: { kind: "shell", command: "true" } }],
      });
      yield* writePlugin("broken.json", "{not json");
      yield* writePlugin("bad-cron.json", {
        name: "Bad cron",
        crons: [{ schedule: "not a cron", run: { kind: "shell", command: "true" } }],
      });
      yield* writePlugin("notes.txt", "ignored");

      const registry = yield* PluginRegistry;
      yield* registry.start;
      const snapshot = yield* registry.getSnapshot;

      assert.deepEqual(
        snapshot.plugins.map((plugin) => plugin.id),
        ["bad-cron", "broken", "notify"],
      );

      const notify = snapshot.plugins.find((plugin) => plugin.id === "notify")!;
      assert.equal(notify.valid, true);
      assert.equal(notify.enabled, true);
      assert.deepEqual(notify.hooks, [{ on: "thread.turn-diff-completed" }]);

      const broken = snapshot.plugins.find((plugin) => plugin.id === "broken")!;
      assert.equal(broken.valid, false);
      assert.equal(broken.enabled, false);
      assert.isDefined(broken.error);

      const badCron = snapshot.plugins.find((plugin) => plugin.id === "bad-cron")!;
      assert.equal(badCron.valid, false);
      assert.include(badCron.error ?? "", "invalid cron expression");
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("rejects crons that set both schedule and every", () =>
    Effect.gen(function* () {
      yield* writePlugin("both.json", {
        name: "Both",
        crons: [{ schedule: "* * * * *", every: "5m", run: { kind: "shell", command: "true" } }],
      });

      const registry = yield* PluginRegistry;
      yield* registry.start;
      const snapshot = yield* registry.getSnapshot;
      const plugin = snapshot.plugins.find((candidate) => candidate.id === "both")!;
      assert.equal(plugin.valid, false);
      assert.include(plugin.error ?? "", 'exactly one of "schedule" or "every"');
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("setPluginEnabled rewrites the manifest and preserves other fields", () =>
    Effect.gen(function* () {
      yield* writePlugin("digest.json", {
        name: "Digest",
        crons: [{ id: "daily", schedule: "0 9 * * *", run: { kind: "shell", command: "true" } }],
      });

      const registry = yield* PluginRegistry;
      yield* registry.start;
      const snapshot = yield* registry.setPluginEnabled({ pluginId: "digest", enabled: false });
      const plugin = snapshot.plugins.find((candidate) => candidate.id === "digest")!;
      assert.equal(plugin.enabled, false);
      assert.deepEqual(plugin.crons, [{ label: "0 9 * * *" }]);

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { pluginsDir } = yield* ServerConfig;
      const raw = JSON.parse(
        yield* fs.readFileString(path.join(pluginsDir, "digest.json")),
      ) as Record<string, unknown>;
      assert.equal(raw.enabled, false);
      assert.equal(raw.name, "Digest");
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("setPluginEnabled fails for unknown plugins", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      yield* registry.start;
      const result = yield* Effect.exit(
        registry.setPluginEnabled({ pluginId: "missing", enabled: true }),
      );
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("loads the directory form and exposes its panel", () =>
    Effect.gen(function* () {
      yield* writePlugin("deploys/plugin.json", {
        name: "Deploys",
        panel: { title: "Deploys", path: "panel/index.html" },
        crons: [{ every: "5m", run: { kind: "shell", command: "true" } }],
      });
      yield* writePlugin("deploys/panel/index.html", "<h1>hi</h1>");
      // Директория без plugin.json — не плагин, молча игнорируется.
      yield* writePlugin("scratch/notes.txt", "ignored");

      const registry = yield* PluginRegistry;
      yield* registry.start;
      const snapshot = yield* registry.getSnapshot;

      assert.deepEqual(
        snapshot.plugins.map((plugin) => plugin.id),
        ["deploys"],
      );
      const deploys = snapshot.plugins[0]!;
      assert.equal(deploys.valid, true);
      assert.equal(deploys.fileName, "deploys/plugin.json");
      assert.deepEqual(deploys.panel, { title: "Deploys" });

      const loaded = yield* registry.getLoadedPlugins;
      assert.isDefined(loaded[0]!.directoryPath);
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("setPluginEnabled works for the directory form", () =>
    Effect.gen(function* () {
      yield* writePlugin("deploys/plugin.json", {
        name: "Deploys",
        panel: { title: "Deploys", path: "index.html" },
      });
      yield* writePlugin("deploys/index.html", "<h1>hi</h1>");

      const registry = yield* PluginRegistry;
      yield* registry.start;
      const snapshot = yield* registry.setPluginEnabled({ pluginId: "deploys", enabled: false });
      assert.equal(snapshot.plugins[0]!.enabled, false);

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { pluginsDir } = yield* ServerConfig;
      const raw = JSON.parse(
        yield* fs.readFileString(path.join(pluginsDir, "deploys", "plugin.json")),
      ) as Record<string, unknown>;
      assert.equal(raw.enabled, false);
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("rejects panels that escape, are missing, or sit in a flat manifest", () =>
    Effect.gen(function* () {
      yield* writePlugin("escape/plugin.json", {
        name: "Escape",
        panel: { title: "Escape", path: "../../etc/passwd" },
      });
      yield* writePlugin("missing/plugin.json", {
        name: "Missing",
        panel: { title: "Missing", path: "panel/index.html" },
      });
      yield* writePlugin("flat.json", {
        name: "Flat",
        panel: { title: "Flat", path: "index.html" },
      });

      const registry = yield* PluginRegistry;
      yield* registry.start;
      const snapshot = yield* registry.getSnapshot;
      const byId = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));

      assert.equal(byId.get("escape")!.valid, false);
      assert.include(byId.get("escape")!.error ?? "", "relative path inside the plugin directory");
      assert.equal(byId.get("missing")!.valid, false);
      assert.include(byId.get("missing")!.error ?? "", "not found");
      assert.equal(byId.get("flat")!.valid, false);
      assert.include(byId.get("flat")!.error ?? "", "only directory plugins");
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("exposes a validated panel.chat and defaults its visibility", () =>
    Effect.gen(function* () {
      yield* writePlugin("assistant/plugin.json", {
        name: "Assistant",
        panel: { title: "Assistant", path: "index.html", chat: { threadTag: "assistant" } },
      });
      yield* writePlugin("assistant/index.html", "<h1>hi</h1>");
      yield* writePlugin("quiet/plugin.json", {
        name: "Quiet",
        panel: {
          title: "Quiet",
          path: "index.html",
          chat: { threadTag: "quiet", visibility: "answers-only" },
        },
      });
      yield* writePlugin("quiet/index.html", "<h1>hi</h1>");

      const registry = yield* PluginRegistry;
      yield* registry.start;
      const snapshot = yield* registry.getSnapshot;
      const byId = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));

      assert.deepEqual(byId.get("assistant")!.panel, {
        title: "Assistant",
        chat: { threadTag: "assistant", visibility: "full" },
      });
      assert.deepEqual(byId.get("quiet")!.panel, {
        title: "Quiet",
        chat: { threadTag: "quiet", visibility: "answers-only" },
      });
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("rejects panel.chat with an empty tag or an unknown visibility", () =>
    Effect.gen(function* () {
      yield* writePlugin("blank/plugin.json", {
        name: "Blank",
        panel: { title: "Blank", path: "index.html", chat: { threadTag: "  " } },
      });
      yield* writePlugin("blank/index.html", "<h1>hi</h1>");
      yield* writePlugin("typo/plugin.json", {
        name: "Typo",
        panel: {
          title: "Typo",
          path: "index.html",
          chat: { threadTag: "typo", visibility: "answers only" },
        },
      });
      yield* writePlugin("typo/index.html", "<h1>hi</h1>");

      const registry = yield* PluginRegistry;
      yield* registry.start;
      const snapshot = yield* registry.getSnapshot;
      const byId = new Map(snapshot.plugins.map((plugin) => [plugin.id, plugin]));

      assert.equal(byId.get("blank")!.valid, false);
      assert.include(byId.get("blank")!.error ?? "", `"threadTag" must not be empty`);
      assert.equal(byId.get("typo")!.valid, false);
      assert.include(byId.get("typo")!.error ?? "", `unknown "visibility"`);
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("marks both forms invalid when a file and a directory claim one id", () =>
    Effect.gen(function* () {
      yield* writePlugin("twin.json", { name: "Twin file" });
      yield* writePlugin("twin/plugin.json", { name: "Twin dir" });

      const registry = yield* PluginRegistry;
      yield* registry.start;
      const snapshot = yield* registry.getSnapshot;

      assert.equal(snapshot.plugins.length, 2);
      for (const plugin of snapshot.plugins) {
        assert.equal(plugin.id, "twin");
        assert.equal(plugin.valid, false);
        assert.include(plugin.error ?? "", 'duplicate plugin id "twin"');
      }
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("recordRun caps history and shows up in snapshots", () =>
    Effect.gen(function* () {
      yield* writePlugin("runs.json", { name: "Runs" });
      const registry = yield* PluginRegistry;
      yield* registry.start;
      for (let index = 0; index < 25; index += 1) {
        yield* registry.recordRun("runs", {
          at: new Date(index).toISOString(),
          trigger: `run-${index}`,
          ok: true,
        });
      }
      const snapshot = yield* registry.getSnapshot;
      const plugin = snapshot.plugins.find((candidate) => candidate.id === "runs")!;
      assert.equal(plugin.recentRuns.length, 20);
      assert.equal(plugin.recentRuns[0]!.trigger, "run-24");
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );
});

/**
 * Hot-reload нужен настоящий таймер (debounce вотчера) и настоящая ФС, поэтому
 * тестовые сервисы (TestClock) здесь отключены.
 */
it.layer(NodeServices.layer, { excludeTestServices: true })("plugin registry watch", (it) => {
  const awaitPluginName = (registry: PluginRegistryShape, id: string, expected: string) =>
    Effect.gen(function* () {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const snapshot = yield* registry.getSnapshot;
        const plugin = snapshot.plugins.find((candidate) => candidate.id === id);
        if (plugin?.name === expected) return plugin;
        yield* Effect.sleep("50 millis");
      }
      return undefined;
    });

  it.effect("picks up edits of plugin.json inside a plugin directory", () =>
    Effect.gen(function* () {
      yield* writePlugin("dash/plugin.json", { name: "Dash" });

      const registry = yield* PluginRegistry;
      yield* registry.start;
      assert.equal((yield* registry.getSnapshot).plugins[0]!.name, "Dash");

      yield* writePlugin("dash/plugin.json", { name: "Dash v2", description: "updated" });
      const reloaded = yield* awaitPluginName(registry, "dash", "Dash v2");
      assert.isDefined(reloaded);
      assert.equal(reloaded!.description, "updated");
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );

  it.effect("picks up a plugin directory created after start", () =>
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      yield* registry.start;
      assert.deepEqual((yield* registry.getSnapshot).plugins, []);

      yield* writePlugin("late/plugin.json", { name: "Late" });
      const created = yield* awaitPluginName(registry, "late", "Late");
      assert.isDefined(created);

      // Директория появилась уже после старта — вотчер должен быть перевешен на
      // неё, иначе правка вложенного манифеста осталась бы незамеченной.
      yield* writePlugin("late/plugin.json", { name: "Late v2" });
      assert.isDefined(yield* awaitPluginName(registry, "late", "Late v2"));
    }).pipe(Effect.provide(makePluginRegistryLayer()), Effect.scoped),
  );
});
