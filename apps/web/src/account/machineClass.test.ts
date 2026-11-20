import { describe, expect, it } from "vitest";

import {
  MAX_PLAN_URL,
  machineClassErrorCode,
  machineClassToSend,
  machineClassUpgradeUrl,
  parseMachineClassSettings,
  shownMachineClass,
} from "./machineClass";

const MAX = parseMachineClassSettings({
  enabled: true,
  default: "",
  effective: "performance",
  performance_included: true,
  classes: ["standard", "performance"],
})!;
const PLUS = parseMachineClassSettings({
  enabled: true,
  default: "",
  effective: "standard",
  performance_included: false,
})!;

describe("machine class", () => {
  it("reads the console's answer and nothing else", () => {
    expect(MAX).toEqual({ enabled: true, effective: "performance", performanceIncluded: true });
    expect(parseMachineClassSettings({ enabled: false, effective: "standard" })?.enabled).toBe(
      false,
    );
    expect(parseMachineClassSettings({ effective: "turbo" })).toBeNull();
    expect(parseMachineClassSettings("404 page not found")).toBeNull();
  });

  it("preselects the account's class; off Max it is always Standard", () => {
    expect(shownMachineClass(null, MAX)).toBe("performance");
    expect(shownMachineClass("standard", MAX)).toBe("standard");
    expect(shownMachineClass(null, PLUS)).toBe("standard");
    expect(shownMachineClass("performance", PLUS)).toBe("standard");
  });

  it("sends class only when the person changed it", () => {
    expect(machineClassToSend(null, MAX)).toBeUndefined();
    expect(machineClassToSend("performance", MAX)).toBeUndefined();
    expect(machineClassToSend("standard", MAX)).toBe("standard");
    expect(machineClassToSend("performance", PLUS)).toBeUndefined();
    expect(machineClassToSend("standard", null)).toBeUndefined();
    expect(machineClassToSend("standard", { ...MAX, enabled: false })).toBeUndefined();
  });

  it("knows the two refusals and where Max is", () => {
    const refused = new Error(
      'Could not create the box: 403: {"error":"PERFORMANCE_REQUIRES_MAX","upgrade_url":"https://console.uno.place/billing"}',
    );
    expect(machineClassErrorCode(refused)).toBe("PERFORMANCE_REQUIRES_MAX");
    expect(machineClassUpgradeUrl(refused)).toBe("https://console.uno.place/billing");
    expect(machineClassErrorCode(new Error('503: {"error":"PERFORMANCE_NO_CAPACITY"}'))).toBe(
      "PERFORMANCE_NO_CAPACITY",
    );
    expect(machineClassUpgradeUrl(new Error("403: PERFORMANCE_REQUIRES_MAX"))).toBe(MAX_PLAN_URL);
    expect(machineClassErrorCode(new Error("409: SHAPE_TOO_LARGE"))).toBeNull();
  });
});
