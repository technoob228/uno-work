import * as path from "node:path";
import * as os from "node:os";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect";

import {
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { HermesAdapterShape } from "../Services/HermesAdapter.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";

class HermesAdapter extends Context.Service<HermesAdapter, HermesAdapterShape>()(
  "test/HermesAdapter",
) {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockHermes() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = path.join(dir, "hermes");
  // PATH: the driver never re-merges the daemon env into the harness's.
  await writeFile(
    wrapperPath,
    `#!/bin/sh\nexport PATH=${JSON.stringify(process.env.PATH ?? "")}\nexec bun ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await chmod(wrapperPath, 0o755);
  return { wrapperPath, hermesHome: path.join(dir, "home") };
}

const hermesAdapterTestLayer = it.layer(
  Layer.effect(
    HermesAdapter,
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => makeMockHermes());
      return yield* makeHermesAdapter(
        Schema.decodeSync(HermesSettings)({ binaryPath: mock.wrapperPath }),
        { environment: { HERMES_HOME: mock.hermesHome } },
      );
    }),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-hermes-adapter-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

hermesAdapterTestLayer("HermesAdapterLive", (it) => {
  it.effect("is no longer in a turn once the turn is over; late updates keep its turn id", () =>
    Effect.gen(function* () {
      const adapter = yield* HermesAdapter;
      const threadId = ThreadId.make("hermes-turn-state");

      const eventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "item.completed" || event.type === "turn.completed",
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "uno/smart" },
      });
      const { turnId } = yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });

      const [session] = yield* adapter.listSessions();
      assert.strictEqual(session?.activeTurnId, undefined);

      // The assistant segment closes after the prompt returned: still this turn's.
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const itemCompleted = events.find((event) => event.type === "item.completed");
      assert.isDefined(itemCompleted);
      assert.strictEqual(itemCompleted?.turnId, turnId);
      assert.strictEqual(events.find((event) => event.type === "turn.completed")?.turnId, turnId);

      yield* adapter.stopSession(threadId);
    }),
  );
});
