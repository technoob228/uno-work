import { describe, expect, it } from "vitest";

import {
  checkTargetComputer,
  classifyTargetComputer,
  ownBoxIdFromSettings,
} from "./targetComputer.ts";

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

describe("classifyTargetComputer", () => {
  it("this computer in every spelling", () => {
    for (const raw of [undefined, null, "", "this", " Local ", "here", 3120, "3120", "box-3120"]) {
      expect(classifyTargetComputer(raw, 3120)).toEqual({ kind: "this" });
    }
  });

  it("another computer by number or by name; on a laptop every id is another one", () => {
    expect(classifyTargetComputer(3121, 3120)).toEqual({ kind: "other", ref: 3121 });
    expect(classifyTargetComputer(" box-3121 ", 3120)).toEqual({ kind: "other", ref: "box-3121" });
    expect(classifyTargetComputer("cc-target", 3120)).toEqual({ kind: "other", ref: "cc-target" });
    expect(classifyTargetComputer(3120, null)).toEqual({ kind: "other", ref: 3120 });
  });

  it("nonsense is invalid", () => {
    for (const raw of [{ id: 1 }, 1.5, -3, true, "x".repeat(201)]) {
      expect(classifyTargetComputer(raw, 3120)).toEqual({ kind: "invalid" });
    }
  });
});
