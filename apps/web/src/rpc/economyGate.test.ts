import { afterEach, describe, expect, it } from "vitest";

import {
  holdEconomyGate,
  isEconomyGateHeld,
  releaseEconomyGate,
  resetEconomyGatesForTests,
  subscribeEconomyGate,
  waitEconomyGate,
} from "./economyGate";

describe("economy reconnect gate", () => {
  afterEach(() => resetEconomyGatesForTests());

  it("is open by default", async () => {
    expect(isEconomyGateHeld()).toBe(false);
    await expect(waitEconomyGate()).resolves.toBeUndefined();
  });

  it("holds reconnects until released, per key", async () => {
    holdEconomyGate("a");
    expect(isEconomyGateHeld("a")).toBe(true);
    expect(isEconomyGateHeld("b")).toBe(false);
    let passed = false;
    const waiting = waitEconomyGate("a").then(() => {
      passed = true;
    });
    await Promise.resolve();
    expect(passed).toBe(false);
    releaseEconomyGate("a");
    await waiting;
    expect(passed).toBe(true);
    expect(isEconomyGateHeld("a")).toBe(false);
  });

  it("notifies listeners on changes only", () => {
    let calls = 0;
    subscribeEconomyGate(() => {
      calls += 1;
    });
    holdEconomyGate();
    holdEconomyGate();
    releaseEconomyGate();
    releaseEconomyGate();
    expect(calls).toBe(2);
  });
});
