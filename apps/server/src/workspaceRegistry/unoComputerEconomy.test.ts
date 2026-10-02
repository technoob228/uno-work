import { describe, expect, it } from "vitest";

import { computerSleepInfo, parseComputerEconomy } from "./unoComputerEconomy.ts";

const economy = (fields: Record<string, unknown>) =>
  parseComputerEconomy({ enabled: true, idle_timeout_s: 300, ...fields });

describe("computerSleepInfo", () => {
  it("is unknown off an Uno computer", () => {
    expect(computerSleepInfo(undefined)).toBeNull();
  });

  it("tells an agent on the free trial that apps sleep and 24/7 needs a plan", () => {
    const info = computerSleepInfo(economy({ locked: true }));
    expect(info?.sleepsWhenIdle).toBe(true);
    expect(info?.canStayOn).toBe(false);
    expect(info?.afterIdle).toBe("5 minutes");
    expect(info?.note).toContain("Never say an app runs 24/7");
    expect(info?.note).toContain("Small");
  });

  it("points to runs: always when economy is on but optional", () => {
    const info = computerSleepInfo(economy({ locked: false }));
    expect(info?.sleepsWhenIdle).toBe(true);
    expect(info?.canStayOn).toBe(true);
    expect(info?.note).toContain('"runs": "always"');
  });

  it("says always on when economy is off", () => {
    const info = computerSleepInfo(parseComputerEconomy({ enabled: false }));
    expect(info?.sleepsWhenIdle).toBe(false);
  });
});
