import { describe, expect, it, vi } from "vitest";

import { FATAL_RELOAD_WINDOW_MS, recoverFromUncaughtError } from "./fatalRecovery";

function deps(now: number, lastReloadAt: number) {
  return {
    now: () => now,
    readLastReloadAt: () => lastReloadAt,
    writeLastReloadAt: vi.fn<(at: number) => void>(),
    reload: vi.fn<() => void>(),
    showScreen: vi.fn<() => void>(),
  };
}

describe("recoverFromUncaughtError", () => {
  it("reloads once instead of leaving a blank page", () => {
    const d = deps(1_000_000, 0);
    expect(recoverFromUncaughtError(d)).toBe("reload");
    expect(d.writeLastReloadAt).toHaveBeenCalledWith(1_000_000);
    expect(d.reload).toHaveBeenCalledOnce();
    expect(d.showScreen).not.toHaveBeenCalled();
  });

  it("shows the recovery screen instead of reloading in a loop", () => {
    const d = deps(1_000_000, 1_000_000 - 5_000);
    expect(recoverFromUncaughtError(d)).toBe("screen");
    expect(d.reload).not.toHaveBeenCalled();
    expect(d.showScreen).toHaveBeenCalledOnce();
  });

  it("reloads again once the previous automatic reload is old", () => {
    const d = deps(1_000_000, 1_000_000 - FATAL_RELOAD_WINDOW_MS - 1);
    expect(recoverFromUncaughtError(d)).toBe("reload");
  });

  it("treats unreadable storage as no previous reload", () => {
    const d = deps(1_000_000, Number.NaN);
    expect(recoverFromUncaughtError(d)).toBe("reload");
  });
});
