import { describe, expect, it } from "vitest";

import { reconcileDevMode } from "./devMode.logic";

const NOW = "2026-10-30T10:00:00.000Z";
const off = { enabled: false, changedAt: null };

describe("reconcileDevMode", () => {
  it("leaves two sides alone when nobody ever chose", () => {
    expect(reconcileDevMode({ local: off, computer: off, now: NOW })).toEqual({ kind: "in-sync" });
  });

  it("carries a device flag from before the sync to the computer, stamped now", () => {
    const local = { enabled: true, changedAt: null };
    expect(reconcileDevMode({ local, computer: off, now: NOW })).toEqual({
      kind: "push",
      state: { enabled: true, changedAt: NOW },
    });
  });

  it("gives a new device the computer's choice", () => {
    const computer = { enabled: true, changedAt: "2026-10-29T10:00:00.000Z" };
    expect(reconcileDevMode({ local: off, computer, now: NOW })).toEqual({
      kind: "adopt",
      state: computer,
    });
  });

  it("the newest change wins in both directions, off included", () => {
    const older = { enabled: true, changedAt: "2026-10-29T10:00:00.000Z" };
    const newer = { enabled: false, changedAt: "2026-10-30T09:00:00.000Z" };
    expect(reconcileDevMode({ local: newer, computer: older, now: NOW })).toEqual({
      kind: "push",
      state: newer,
    });
    expect(reconcileDevMode({ local: older, computer: newer, now: NOW })).toEqual({
      kind: "adopt",
      state: newer,
    });
  });

  it("does nothing when the two already agree", () => {
    const state = { enabled: true, changedAt: "2026-10-29T10:00:00.000Z" };
    expect(reconcileDevMode({ local: state, computer: state, now: NOW })).toEqual({
      kind: "in-sync",
    });
  });
});
