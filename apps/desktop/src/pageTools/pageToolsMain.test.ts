import { describe, expect, it } from "vitest";

import { isPageToolsPartition } from "./pageToolsMain.ts";

describe("isPageToolsPartition", () => {
  it("is the panel browser's partitions only", () => {
    expect(isPageToolsPartition("persist:uno-browser")).toBe(true);
    expect(isPageToolsPartition("persist:uno-browser-p-my_project")).toBe(true);
    expect(isPageToolsPartition("persist:uno-apps")).toBe(false);
    expect(isPageToolsPartition("persist:uno-browserish")).toBe(false);
    expect(isPageToolsPartition(undefined)).toBe(false);
  });
});
