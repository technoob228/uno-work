import { describe, expect, it } from "vitest";

import { checkTargetComputer, ownBoxIdFromSettings } from "./targetComputer.ts";

describe("checkTargetComputer", () => {
  it("lets through this computer in every spelling", () => {
    for (const raw of [undefined, null, "", "this", " Local ", "self", 3120, "3120", "box-3120"]) {
      expect(checkTargetComputer(raw, 3120).ok).toBe(true);
    }
  });

  it("refuses another computer, and any id on a laptop", () => {
    for (const [raw, own] of [
      [3121, 3120],
      ["box-3121", 3120],
      ["shop-server", 3120],
      [3120, null],
      [{ id: 3120 }, 3120],
    ] as const) {
      const check = checkTargetComputer(raw, own);
      expect(check.ok).toBe(false);
      if (!check.ok) {
        expect(check.code).toBe("computer_not_allowed");
        expect(check.message).toMatch(/not allowed yet/);
      }
    }
  });

  it("reads the box id from settings", () => {
    expect(ownBoxIdFromSettings({ boxId: 3120 })).toBe(3120);
    expect(ownBoxIdFromSettings({ boxId: null })).toBeNull();
    expect(ownBoxIdFromSettings(undefined)).toBeNull();
  });
});
