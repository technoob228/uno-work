import { describe, expect, it } from "vitest";

import { coreChoices, isSustained, ramChoices, resizeEffect, sizeChoices } from "./resizeModel";

describe("sizeChoices", () => {
  it("offers the current size, growth up to the plan, and two sizes past it", () => {
    expect(sizeChoices([1, 2, 4, 8, 16, 32], 2, 8)).toEqual([
      { value: 2, abovePlan: false },
      { value: 4, abovePlan: false },
      { value: 8, abovePlan: false },
      { value: 16, abovePlan: true },
      { value: 32, abovePlan: true },
    ]);
  });

  it("includes an off-grid plan maximum", () => {
    expect(ramChoices(2048, 6144 + 512).map((c) => c.value)).toContain(6656);
  });

  it("marks everything above as a plan upgrade when the computer is already at the top", () => {
    const cores = coreChoices(4, 4);
    expect(cores[0]).toEqual({ value: 4, abovePlan: false });
    expect(cores.slice(1).every((c) => c.abovePlan)).toBe(true);
  });
});

describe("resizeEffect", () => {
  const cur = { ramMb: 2048, vcpu: 1, diskGb: 10 };
  it("says memory and disk apply live, cores restart", () => {
    expect(resizeEffect(cur, cur)).toBe("none");
    expect(resizeEffect(cur, { ...cur, ramMb: 4096 })).toBe("live");
    expect(resizeEffect(cur, { ...cur, diskGb: 20 })).toBe("live");
    expect(resizeEffect(cur, { ...cur, vcpu: 2 })).toBe("restart");
  });
});

describe("isSustained", () => {
  it("needs every recent sample over the line", () => {
    expect(isSustained([90, 91, 92, 93, 94], 85)).toBe(true);
    expect(isSustained([90, 91, 80, 93, 94], 85)).toBe(false);
    expect(isSustained([90, 91], 85)).toBe(false);
    expect(isSustained([10, 90, 91, 92, 93, 94], 85)).toBe(true);
  });
});
