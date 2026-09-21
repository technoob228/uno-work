import { Duration, Effect } from "effect";

import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

/** Upper bound for boot-time defaults waiting on the first harness probes. */
export const BOOT_DEFAULT_PROBE_WAIT = Duration.seconds(45);

/**
 * Boot probes run in the background (the HTTP server must not wait for slow
 * harness binaries), so right after start the registry may still hold only
 * cached/fallback snapshots. Anything that picks a default model at boot
 * waits here — bounded — for those probes, exactly as when they were awaited
 * during layer build. Never fails; registries without background probing
 * (tests, mocks) don't make the caller wait at all.
 */
export const awaitUsableBootDefault = (maxWait: Duration.Input = BOOT_DEFAULT_PROBE_WAIT) =>
  Effect.gen(function* () {
    const providerRegistry = yield* ProviderRegistry;
    const awaitBootProbes = providerRegistry.awaitBootProbes;
    if (awaitBootProbes === undefined) return;
    yield* awaitBootProbes.pipe(Effect.timeoutOption(maxWait), Effect.asVoid);
  });
