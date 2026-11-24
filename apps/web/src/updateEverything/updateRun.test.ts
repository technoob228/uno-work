import { afterEach, describe, expect, it } from "vitest";

import {
  beginUpdateRun,
  clearUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  reportUpdateProgress,
} from "./updateRun";

describe("the update run outlives the dialog", () => {
  afterEach(() => {
    finishUpdateRun();
    clearUpdateRun();
  });

  it("keeps progress after the window closes, and one run at a time", () => {
    expect(beginUpdateRun([], null)).toBe(true);
    reportUpdateProgress("a", { kind: "working", step: "Updating Uno Work" });
    // Closing the window while it runs: nothing is cleared.
    clearUpdateRun();
    expect(getUpdateRun().phase).toBe("running");
    expect(getUpdateRun().progress.get("a")).toEqual({
      kind: "working",
      step: "Updating Uno Work",
    });
    expect(beginUpdateRun([], null)).toBe(false);
    finishUpdateRun();
    clearUpdateRun();
    expect(getUpdateRun().phase).toBe("idle");
  });
});
