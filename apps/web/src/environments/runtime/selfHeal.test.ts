import { describe, expect, it } from "vitest";

import { getSelfHealBackoffDelayMs } from "./selfHeal";

describe("getSelfHealBackoffDelayMs", () => {
  it("doubles from 1 s to a 64 s cap, jittered within the upper half of each step", () => {
    expect(getSelfHealBackoffDelayMs(1, 0)).toBe(500);
    expect(getSelfHealBackoffDelayMs(1, 0.999_999)).toBe(1_000);
    expect(getSelfHealBackoffDelayMs(2, 0)).toBe(1_000);
    expect(getSelfHealBackoffDelayMs(4, 0.5)).toBe(6_000);
    expect(getSelfHealBackoffDelayMs(7, 0)).toBe(32_000);
    expect(getSelfHealBackoffDelayMs(50, 1)).toBe(64_000);
  });

  it("spreads machines that failed together", () => {
    const delays = new Set(
      Array.from({ length: 20 }, (_, index) => getSelfHealBackoffDelayMs(5, index / 20)),
    );
    expect(delays.size).toBeGreaterThan(10);
  });
});
