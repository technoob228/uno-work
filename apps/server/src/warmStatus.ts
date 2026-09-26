import { Duration, Effect, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { AssistantPrewarm } from "./manager/assistantPrewarm.ts";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";

/**
 * GET /__uno/warm — "is this daemon warm enough to be frozen into a memory
 * snapshot?" (reports/day_2026-09-25/work-first-answer).
 *
 * The node agent warms an image's memory snapshot by booting a throwaway VM
 * and pausing it after a fixed settle (20 s). For Uno Work that froze a daemon
 * still probing its harnesses (~20–25 s on 2 vCPU, measured 25.09), so every
 * clone would redo the probes. With this endpoint the node can wait for the
 * real signal instead: 200 once the boot probes have finished and the Uno
 * chat's Hermes is up (or cannot be — no gateway key before provisioning — or
 * 30 s have passed: manager/assistantPrewarm.ts), 503 before.
 *
 * Public on purpose (the node asks without a session) and says nothing but a
 * boolean. The router attaches only after the startup gate is released, so a
 * daemon still starting answers the gate's 503 on this path as well.
 */
export const WARM_STATUS_PATH = "/__uno/warm";

export const warmStatusRouteLayer = HttpRouter.add(
  "GET",
  WARM_STATUS_PATH,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const probesDone =
      registry.awaitBootProbes === undefined
        ? true
        : Option.isSome(
            yield* registry.awaitBootProbes.pipe(Effect.timeoutOption(Duration.millis(1))),
          );
    const prewarm = yield* Effect.serviceOption(AssistantPrewarm);
    const assistantReady = Option.isNone(prewarm) ? true : yield* prewarm.value.settled;
    const warm = probesDone && assistantReady;
    return HttpServerResponse.jsonUnsafe(
      { warm },
      { status: warm ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  }),
);
