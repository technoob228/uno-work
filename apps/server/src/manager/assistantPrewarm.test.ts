import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSession,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderSessionPrewarmOutcome,
} from "../orchestration/Services/ProviderCommandReactor.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoGatewayKey } from "../unoGatewayKey.ts";
import {
  AssistantPrewarm,
  AssistantPrewarmLive,
  assistantPrewarmDisabled,
} from "./assistantPrewarm.ts";

const CHAT_ID = ThreadId.make("thread-uno");

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("assistantPrewarm", () => {
  let runtime: ManagedRuntime.ManagedRuntime<AssistantPrewarm, unknown> | null = null;
  afterEach(async () => {
    await runtime?.dispose();
    runtime = null;
  });

  function createHarness(input: { key: string; installed?: boolean }) {
    const state = { key: input.key, sessions: [] as Array<ProviderSession>, starts: 0 };
    const pokes = Effect.runSync(PubSub.unbounded<ReadonlyArray<ServerProvider>>());
    const prewarmSession = vi.fn((threadId: ThreadId, options?: { readonly restart?: boolean }) =>
      Effect.sync((): ProviderSessionPrewarmOutcome => {
        const live = state.sessions.some((session) => session.threadId === threadId);
        if (live && options?.restart !== true) return "already-running";
        state.starts += 1;
        const createdAt = `2026-09-26T00:00:0${state.starts}.000Z`;
        state.sessions = [
          {
            provider: ProviderDriverKind.make("hermes"),
            providerInstanceId: ProviderInstanceId.make("hermes"),
            status: "ready",
            runtimeMode: "full-access",
            threadId,
            createdAt,
            updatedAt: createdAt,
          },
        ];
        return "started";
      }),
    );
    const layer = AssistantPrewarmLive.pipe(
      Layer.provide(Layer.mock(ProviderCommandReactor, { prewarmSession })),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery, {
          getShellSnapshot: () =>
            Effect.succeed({
              threads: [
                {
                  id: CHAT_ID,
                  assistantRole: "chat",
                  archivedAt: null,
                  createdAt: "2026-09-26T00:00:00.000Z",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("hermes"),
                    model: "uno/smart",
                  },
                },
              ],
            } as never),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderService, {
          listSessions: () => Effect.sync(() => state.sessions),
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("hermes"),
              installed: input.installed ?? true,
            } as never,
          ]),
          streamChanges: Stream.fromPubSub(pokes),
          awaitBootProbes: Effect.void,
        }),
      ),
      Layer.provide(Layer.mock(ServerSettingsService, { streamChanges: Stream.empty })),
      Layer.provide(
        Layer.mock(UnoGatewayKey, {
          harnessKey: () => Effect.sync(() => state.key),
          labelThread: () => undefined,
          appOfThread: () => null,
        }),
      ),
      Layer.provide(Layer.mock(OrchestrationEngineService, { streamDomainEvents: Stream.empty })),
    );
    runtime = ManagedRuntime.make(layer);
    const settled = () =>
      runtime!.runPromise(Effect.flatMap(Effect.service(AssistantPrewarm), (s) => s.settled));
    const poke = () => Effect.runPromise(PubSub.publish(pokes, []));
    return { state, prewarmSession, settled, poke, runtime };
  }

  it("starts the Uno chat's harness once the key is there and reports warm", async () => {
    const harness = createHarness({ key: "unollm_first-key-000000" });
    await harness.settled();
    await waitFor(() => harness.prewarmSession.mock.calls.length === 1);
    expect(harness.prewarmSession.mock.calls[0]?.[0]).toBe(CHAT_ID);
    expect(harness.prewarmSession.mock.calls[0]?.[1]).toEqual({ restart: false });
    await waitFor(() => harness.state.starts === 1);
    expect(await harness.settled()).toBe(true);

    // Nothing changed: a poke does not restart it.
    await harness.poke();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(harness.state.starts).toBe(1);
  });

  it("restarts the idle harness in the background when the gateway key changes", async () => {
    const harness = createHarness({ key: "unollm_snapshot-key-0000" });
    await harness.settled();
    await waitFor(() => harness.state.starts === 1);

    harness.state.key = "unollm_clone-own-key-000";
    await harness.poke();
    await waitFor(() => harness.state.starts === 2);
    expect(harness.prewarmSession.mock.calls.at(-1)?.[1]).toEqual({ restart: true });
  });

  it("does not start without a gateway key, and settles so a snapshot is not held", async () => {
    const harness = createHarness({ key: "" });
    await harness.settled();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.prewarmSession).not.toHaveBeenCalled();
    expect(await harness.settled()).toBe(true);

    // The key lands (the console writes it after the clone boots).
    harness.state.key = "unollm_arrived-later-000";
    await harness.poke();
    await waitFor(() => harness.state.starts === 1);
  });

  it("can be turned off", () => {
    expect(assistantPrewarmDisabled({ UNO_WORK_ASSISTANT_PREWARM: "0" })).toBe(true);
    expect(assistantPrewarmDisabled({})).toBe(false);
  });
});
