import { describe, expect, it } from "vitest";

import { sizingNow, sizingPct, sizingWhen, sizingWhy } from "./sizingModel";

const sizing = {
  mode: "auto" as const,
  cpu: { current: 6, base: 2, max: 8 },
  memoryMb: { current: 6144, base: 2048, max: 8192 },
  diskGb: { current: 40, base: 40, max: 40 },
  history: [],
};

describe("sizingModel", () => {
  it("says the size right now", () => {
    expect(sizingNow(sizing)).toBe("6 cores · 6 GB");
  });
  it("keeps the bar within 0–100", () => {
    expect(sizingPct(6, 8)).toBe(75);
    expect(sizingPct(9, 8)).toBe(100);
    expect(sizingPct(1, 0)).toBe(0);
  });
  it("words the reasons", () => {
    expect(sizingWhy("pressure")).toBe("under load");
    expect(sizingWhy("node_limit")).toContain("busy");
  });
  it("says when", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(sizingWhen("2026-11-20T11:59:50Z", now)).toBe("just now");
    expect(sizingWhen("2026-11-20T11:19:00Z", now)).toBe("41 min ago");
    expect(sizingWhen("2026-11-20T09:00:00Z", now)).toBe("3 h ago");
  });
});
