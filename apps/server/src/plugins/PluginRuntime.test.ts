import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OrchestrationEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer, Path, PubSub, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PluginRegistry, PluginRegistryLive } from "./PluginRegistry.ts";
import { PluginRuntime, PluginRuntimeLive } from "./PluginRuntime.ts";

const testEvent = (type: string): OrchestrationEvent =>
  ({ type, payload: { marker: "plugin-runtime-test" } }) as unknown as OrchestrationEvent;

const awaitFirstRun = (pluginId: string) =>
  Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = yield* registry.getSnapshot;
      const plugin = snapshot.plugins.find((candidate) => candidate.id === pluginId);
      const run = plugin?.recentRuns[0];
      if (run !== undefined) {
        return run;
      }
      yield* Effect.sleep(Duration.millis(50));
    }
    return undefined;
  });

// `excludeTestServices` keeps the live Clock: hook actions spawn real shell
// processes, so TestClock-driven sleeps would never line up with their IO.
it.layer(NodeServices.layer, { excludeTestServices: true })("plugin runtime", (it) => {
  it.effect("runs a matching hook via the shell and records the outcome", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: () => Effect.die("not used in this test"),
        streamDomainEvents: Stream.fromPubSub(events),
      });
      const runtimeLayer = PluginRuntimeLive.pipe(
        Layer.provide(engineLayer),
        Layer.provideMerge(PluginRegistryLive),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-runtime-test-" }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { pluginsDir } = yield* ServerConfig;
        yield* fs.makeDirectory(pluginsDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(pluginsDir, "echo.json"),
          JSON.stringify({
            name: "Echo",
            hooks: [
              {
                on: "thread.*",
                run: { kind: "shell", command: 'printf "type=%s" "$UNO_PLUGIN_EVENT_TYPE"' },
              },
            ],
          }),
        );

        const registry = yield* PluginRegistry;
        yield* registry.start;
        const runtime = yield* PluginRuntime;
        yield* runtime.start();
        // Give the forked event worker a beat to attach its PubSub subscription.
        yield* Effect.sleep(Duration.millis(250));

        // Non-matching event first: must not produce a run.
        yield* PubSub.publish(events, testEvent("project.created"));
        yield* PubSub.publish(events, testEvent("thread.created"));

        const run = yield* awaitFirstRun("echo");
        assert.isDefined(run);
        assert.equal(run!.ok, true);
        assert.equal(run!.trigger, "thread.created");
        assert.include(run!.detail ?? "", "type=thread.created");

        const snapshot = yield* registry.getSnapshot;
        const plugin = snapshot.plugins.find((candidate) => candidate.id === "echo")!;
        assert.equal(plugin.recentRuns.length, 1);
      }).pipe(Effect.provide(runtimeLayer), Effect.scoped);
    }),
  );

  it.effect("skips hooks of disabled plugins", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: () => Effect.die("not used in this test"),
        streamDomainEvents: Stream.fromPubSub(events),
      });
      const runtimeLayer = PluginRuntimeLive.pipe(
        Layer.provide(engineLayer),
        Layer.provideMerge(PluginRegistryLive),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-plugin-runtime-test-" }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { pluginsDir } = yield* ServerConfig;
        yield* fs.makeDirectory(pluginsDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(pluginsDir, "disabled.json"),
          JSON.stringify({
            name: "Disabled",
            enabled: false,
            hooks: [{ on: "*", run: { kind: "shell", command: "true" } }],
          }),
        );

        const registry = yield* PluginRegistry;
        yield* registry.start;
        const runtime = yield* PluginRuntime;
        yield* runtime.start();
        yield* Effect.sleep(Duration.millis(250));

        yield* PubSub.publish(events, testEvent("thread.created"));
        yield* Effect.sleep(Duration.millis(500));

        const snapshot = yield* registry.getSnapshot;
        const plugin = snapshot.plugins.find((candidate) => candidate.id === "disabled")!;
        assert.equal(plugin.recentRuns.length, 0);
      }).pipe(Effect.provide(runtimeLayer), Effect.scoped);
    }),
  );
});
