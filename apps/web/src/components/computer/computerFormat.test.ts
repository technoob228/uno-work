import { describe, expect, it } from "vitest";

import {
  awakeLine,
  computerPowerState,
  displayAddress,
  humanDuration,
  percent,
  sizeLine,
  sparklinePath,
} from "./computerFormat";

describe("computerPowerState", () => {
  it("speaks about a computer, not a box", () => {
    expect(computerPowerState("running")).toBe("on");
    expect(computerPowerState("sleeping")).toBe("asleep");
    expect(computerPowerState("stopped")).toBe("off");
    expect(computerPowerState("provisioning")).toBe("busy");
    expect(computerPowerState(undefined)).toBe("unknown");
  });
});

describe("awakeLine", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");

  it("counts how long it has been awake", () => {
    expect(awakeLine({ status: "running", startedAt: "2026-09-18T08:00:00Z" }, now)).toBe(
      "awake for 3 days",
    );
    expect(awakeLine({ status: "running", startedAt: "2026-09-21T11:59:30Z" }, now)).toBe(
      "just woke up",
    );
  });

  it("does not invent an uptime it was not told", () => {
    expect(awakeLine({ status: "running", startedAt: null }, now)).toBeNull();
    expect(awakeLine({ status: "stopped", startedAt: null }, now)).toBeNull();
    expect(awakeLine({ status: "sleeping", startedAt: null }, now)).toBe(
      "wakes up when you need it",
    );
  });
});

describe("sizes", () => {
  it("reads like a spec sheet", () => {
    expect(sizeLine({ ramMb: 2048, vcpu: 2, diskGb: 30 })).toBe(
      "2 GB memory · 2 cores · 30 GB disk",
    );
    expect(sizeLine({ ramMb: 512, vcpu: 1, diskGb: 0 })).toBe("512 MB memory · 1 core");
    expect(humanDuration(7_300)).toBe("2 hours");
    expect(percent(900, 2048)).toBeCloseTo(43.9, 1);
    expect(percent(null, 10)).toBe(0);
    expect(displayAddress("https://kuma.example/")).toBe("kuma.example");
  });
});

describe("sparklinePath", () => {
  it("draws nothing for a single point and a closed area for a trend", () => {
    expect(sparklinePath([{ t: "a", cpuPct: 5, memMb: 1 }], 100, 20).line).toBe("");
    const path = sparklinePath(
      [
        { t: "a", cpuPct: 0, memMb: 1 },
        { t: "b", cpuPct: 100, memMb: 1 },
      ],
      100,
      20,
    );
    expect(path.line).toBe("M0.0,20.0 L100.0,0.0");
    expect(path.area.endsWith("Z")).toBe(true);
  });
});
