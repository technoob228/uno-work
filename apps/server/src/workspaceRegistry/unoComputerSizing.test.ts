import { describe, expect, it } from "vitest";

import { hasAutosize, parseComputerSizing } from "./unoComputerSizing.ts";

const answer = {
  box_id: 2961,
  mode: "auto",
  running: true,
  cpu: { current: 6, base: 2, max: 8 },
  memory_mb: { current: 6144, base: 2048, max: 8192 },
  disk_gb: { current: 40, base: 40, max: 40 },
  history: [
    {
      seq: 1,
      at: "2026-11-20T10:00:00Z",
      resource: "cpu",
      from: 0,
      to: 2,
      reason: "boot",
      applied: true,
    },
    {
      seq: 2,
      at: "2026-11-20T11:00:00Z",
      resource: "cpu",
      from: 2,
      to: 6,
      reason: "pressure",
      applied: true,
    },
    {
      seq: 3,
      at: "2026-11-20T11:00:01Z",
      resource: "memory_mb",
      from: 2048,
      to: 6144,
      reason: "pressure",
      applied: true,
    },
  ],
};

describe("hasAutosize", () => {
  it("asks /sizing only when the box carries autosize", () => {
    expect(hasAutosize({ id: 1, autosize: { max_vcpu: 8, max_ram_mb: 8192 } })).toBe(true);
    expect(hasAutosize({ id: 1 })).toBe(false);
    expect(hasAutosize(null)).toBe(false);
  });
});

describe("parseComputerSizing", () => {
  it("maps the answer and drops the boot lines", () => {
    const s = parseComputerSizing(answer);
    expect(s?.mode).toBe("auto");
    expect(s?.cpu).toEqual({ current: 6, base: 2, max: 8 });
    expect(s?.memoryMb.current).toBe(6144);
    expect(s?.history.map((e) => `${e.resource}:${e.from}->${e.to}`)).toEqual([
      "cpu:2->6",
      "memory:2048->6144",
    ]);
  });

  it("shows nothing for a computer without it", () => {
    expect(parseComputerSizing({ ...answer, mode: "none" })).toBeNull();
    expect(parseComputerSizing({ ...answer, mode: "unknown" })).toBeNull();
    expect(parseComputerSizing({ mode: "auto" })).toBeNull();
    expect(parseComputerSizing("nope")).toBeNull();
  });

  it("keeps max at least base", () => {
    const s = parseComputerSizing({ ...answer, cpu: { current: 2, base: 2, max: 1 } });
    expect(s?.cpu.max).toBe(2);
  });
});
