import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AcpSessionRuntime, type AcpSpawnInput } from "./AcpSessionRuntime.ts";
import { buildCursorAcpSpawnInput } from "./CursorAcpSupport.ts";
import { buildHermesAcpSpawnInput } from "./HermesAcpSupport.ts";

const UNO_SECRET = "unollm_" + "a".repeat(24);

/** Spawner that records what would be spawned and refuses to run it. */
function capturingSpawner() {
  const captured: Array<{ readonly env: Record<string, string | undefined> | undefined }> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand") captured.push({ env: command.options.env });
    return Effect.die("spawn refused in test");
  });
  return { captured, spawner };
}

async function captureEnv(spawn: AcpSpawnInput) {
  const { captured, spawner } = capturingSpawner();
  await Effect.runPromiseExit(
    Layer.build(
      AcpSessionRuntime.layer({
        spawn,
        cwd: process.cwd(),
        clientInfo: { name: "t3-test", version: "0.0.0" },
        authMethodId: "test",
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    ).pipe(Effect.scoped),
  );
  return captured[0]?.env;
}

describe("ACP harness spawn environment", () => {
  beforeEach(() => {
    process.env.UNO_WORK_API_KEY = "uno_usr_" + "b".repeat(24);
    process.env.T3_TEST_GATEWAY_SECRET = UNO_SECRET;
  });
  afterEach(() => {
    delete process.env.UNO_WORK_API_KEY;
    delete process.env.T3_TEST_GATEWAY_SECRET;
  });

  it("Hermes and Cursor run on the env the driver built — no daemon env re-merged", async () => {
    for (const spawn of [
      buildHermesAcpSpawnInput(null, "/tmp", { PATH: "/usr/bin", HERMES_HOME: "/tmp/h" }),
      buildCursorAcpSpawnInput(null, "/tmp", { PATH: "/usr/bin" }),
    ]) {
      expect(spawn.inheritProcessEnv).toBe(false);
      expect(spawn.forceKillAfterMs).toBe(3_000);
      const env = await captureEnv(spawn);
      expect(env?.UNO_WORK_API_KEY).toBeUndefined();
      expect(env?.T3_TEST_GATEWAY_SECRET).toBeUndefined();
      expect(env?.PATH).toBe("/usr/bin");
    }
  });

  it("without an env, a no-inherit harness gets the sanitized daemon env", async () => {
    const env = await captureEnv({ command: "x", args: [], inheritProcessEnv: false });
    expect(env?.UNO_WORK_API_KEY).toBeUndefined();
    expect(env?.T3_TEST_GATEWAY_SECRET).toBeUndefined();
    expect(env?.PATH).toBe(process.env.PATH);
  });

  it("other ACP spawns keep the historical merge", async () => {
    const env = await captureEnv({ command: "x", args: [], env: { FOO: "1" } });
    expect(env?.FOO).toBe("1");
    expect(env?.UNO_WORK_API_KEY).toBeDefined();
  });
});

describe("ACP harness SIGTERM → SIGKILL deadline", () => {
  it("does not hang closing the session on an agent that ignores SIGTERM", async () => {
    const started = Date.now();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const scope = yield* Scope.make("sequential");
        yield* Layer.buildWithScope(
          AcpSessionRuntime.layer({
            spawn: {
              command: "sh",
              args: ["-c", "trap '' TERM; while :; do sleep 0.2; done"],
              forceKillAfterMs: 300,
            },
            cwd: process.cwd(),
            clientInfo: { name: "t3-test", version: "0.0.0" },
            authMethodId: "test",
          }),
          scope,
        );
        yield* Effect.sleep("300 millis");
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);
});
