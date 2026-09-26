import { Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { bootProbesFinished } from "./awaitUsableBootDefault.ts";

describe("bootProbesFinished", () => {
  it("is true for registries that do not probe in the background", async () => {
    expect(await Effect.runPromise(bootProbesFinished({}))).toBe(true);
  });

  it("answers without waiting while the probes run, and true once they are done", async () => {
    const program = Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      const registry = { awaitBootProbes: Deferred.await(done) };
      const before = yield* bootProbesFinished(registry);
      yield* Deferred.succeed(done, undefined);
      const after = yield* bootProbesFinished(registry);
      return { before, after };
    });
    expect(await Effect.runPromise(program)).toEqual({ before: false, after: true });
  });
});
