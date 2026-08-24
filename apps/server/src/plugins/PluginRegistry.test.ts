import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../config.ts";
import { PluginRegistry, PluginRegistryLive } from "./PluginRegistry.ts";

const makePluginRegistryLayer = () =>
  PluginRegistryLive.pipe(
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
    yield* fs.makeDirectory(pluginsDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(pluginsDir, fileName),
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
