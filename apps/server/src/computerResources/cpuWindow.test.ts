import { describe, expect, it } from "vitest";

import { CpuLoadWindow } from "./cpuWindow.ts";

/** Cumulative totals for a 2-core machine, 100 ticks per core per second. */
function machine() {
  let idle = 0;
  let total = 0;
  return {
    run(seconds: number, busyShare: number) {
      const ticks = seconds * 200;
      total += ticks;
      idle += ticks * (1 - busyShare);
    },
    get totals() {
      return { idle, total };
    },
  };
}

describe("CpuLoadWindow", () => {
  it("has nothing to say before there is a baseline", () => {
    const w = new CpuLoadWindow(15_000);
    expect(w.sample(0, { idle: 0, total: 0 })).toBeNull();
    expect(w.sample(1_000, null)).toBeNull();
  });

  it("a short burst right before the read no longer reads as a busy computer", () => {
    const m = machine();
    const w = new CpuLoadWindow(15_000);
    let t = 0;
    w.sample(t, m.totals);
    // Idle at 3% for a minute, read every 3 s like the screen does…
    for (let i = 0; i < 20; i++) {
      m.run(3, 0.03);
      t += 3_000;
      w.sample(t, m.totals);
    }
    // …then Uno Work itself saturates both cores for 2.5 s, and the screen reads.
    m.run(0.5, 0.03);
    t += 500;
    w.sample(t, m.totals); // a second screen/tab asking in between
    m.run(2.5, 1);
    t += 2_500;
    const pct = w.sample(t, m.totals)!;
    // The old "since the last read" math gave 100% here.
    expect(pct).toBeLessThan(25);
  });

  it("a steady load still shows as it is once it fills the window", () => {
    const m = machine();
    const w = new CpuLoadWindow(15_000);
    let t = 0;
    w.sample(t, m.totals);
    for (let i = 0; i < 10; i++) {
      m.run(3, 0.03);
      t += 3_000;
      w.sample(t, m.totals);
    }
    let pct = 0;
    for (let i = 0; i < 6; i++) {
      m.run(3, 1); // `yes` on both cores
      t += 3_000;
      pct = w.sample(t, m.totals)!;
    }
    expect(pct).toBeGreaterThan(95);
  });

  it("many callers don't shrink the window", () => {
    const m = machine();
    const w = new CpuLoadWindow(15_000);
    let t = 0;
    w.sample(t, m.totals);
    for (let i = 0; i < 200; i++) {
      m.run(0.25, 0.05);
      t += 250;
      w.sample(t, m.totals);
    }
    m.run(0.25, 1);
    t += 250;
    // 0.25 s at 100% inside a 15 s window of 5%.
    expect(w.sample(t, m.totals)!).toBeLessThan(8);
  });
});
