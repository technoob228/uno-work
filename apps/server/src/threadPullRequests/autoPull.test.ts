import { describe, expect, it } from "vitest";

import { shouldAutoPull } from "./autoPull.ts";

const clean = {
  branch: "main",
  defaultBranch: "main",
  hasUpstream: true,
  dirty: false,
  aheadOfUpstream: 0,
};

describe("shouldAutoPull", () => {
  it("pulls a clean default branch", () => {
    expect(shouldAutoPull(clean)).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(shouldAutoPull({ ...clean, branch: "feature" })).toBe(false);
    expect(shouldAutoPull({ ...clean, branch: "" })).toBe(false);
    expect(shouldAutoPull({ ...clean, defaultBranch: null })).toBe(false);
    expect(shouldAutoPull({ ...clean, hasUpstream: false })).toBe(false);
    expect(shouldAutoPull({ ...clean, dirty: true })).toBe(false);
    expect(shouldAutoPull({ ...clean, aheadOfUpstream: 1 })).toBe(false);
  });
});
