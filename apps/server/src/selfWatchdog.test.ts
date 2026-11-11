import { readFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { HealthProbeError } from "./health.ts";
import {
  consumeWatchdogExitFlag,
  isWatchdogExitEnabled,
  runSelfWatchdog,
  WATCHDOG_EXIT_CODE,
} from "./selfWatchdog.ts";

const failing = () =>
  Effect.fail(new HealthProbeError({ detail: "database did not answer within 15000ms" }));
/** A probe whose own timeout could not interrupt it. */
const hanging = () => Effect.never;

it("the Uno computer's unit lets the watchdog restart a stuck daemon", () => {
  const unit = readFileSync(new URL("../../../deploy/uno-work.service", import.meta.url), "utf8");
  assert.match(unit, /^Environment=T3_WATCHDOG_EXIT=1$/m);
  assert.match(unit, /^Restart=always$/m);
});

it("consumes the exit flag so children of the daemon don't inherit it", () => {
  const env: NodeJS.ProcessEnv = { T3_WATCHDOG_EXIT: "1", PATH: "/bin" };
  assert.equal(consumeWatchdogExitFlag(env), true);
  assert.equal(isWatchdogExitEnabled(env), false);
  assert.equal("T3_WATCHDOG_EXIT" in env, false);
  assert.equal(env["PATH"], "/bin");
  assert.equal(consumeWatchdogExitFlag({}), false);
});

it.effect("exits for the supervisor after three failed minutes when enabled", () =>
  Effect.gen(function* () {
    const exits: Array<number> = [];
    const fiber = yield* Effect.forkChild(
      runSelfWatchdog({ probe: failing, exitEnabled: true, exit: (code) => exits.push(code) }),
    );
    yield* TestClock.adjust("2 minutes");
    assert.deepEqual(exits, []);
    yield* TestClock.adjust("1 minute");
    assert.deepEqual(exits, [WATCHDOG_EXIT_CODE]);
    yield* Fiber.join(fiber);
  }),
);

it.effect("a probe that never returns still counts as a failure", () =>
  Effect.gen(function* () {
    const exits: Array<number> = [];
    yield* Effect.forkChild(
      runSelfWatchdog({ probe: hanging, exitEnabled: true, exit: (code) => exits.push(code) }),
    );
    // Three intervals plus three outer bounds (probe timeout + 5 s each).
    yield* TestClock.adjust("4 minutes");
    assert.deepEqual(exits, [WATCHDOG_EXIT_CODE]);
  }),
);

it.effect("a success in between starts the count over", () =>
  Effect.gen(function* () {
    const exits: Array<number> = [];
    let calls = 0;
    yield* Effect.forkChild(
      runSelfWatchdog({
        probe: () => {
          calls += 1;
          return calls === 3 ? Effect.succeed(1) : failing();
        },
        exitEnabled: true,
        exit: (code) => exits.push(code),
      }),
    );
    // fail, fail, ok, fail, fail: still running after five minutes.
    yield* TestClock.adjust("5 minutes");
    assert.deepEqual(exits, []);
    yield* TestClock.adjust("1 minute");
    assert.deepEqual(exits, [WATCHDOG_EXIT_CODE]);
  }),
);

it.effect("never exits without a supervisor", () =>
  Effect.gen(function* () {
    const exits: Array<number> = [];
    yield* Effect.forkChild(
      runSelfWatchdog({ probe: failing, exitEnabled: false, exit: (code) => exits.push(code) }),
    );
    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(exits, []);
  }),
);
