import { describe, expect, it } from "vitest";

import { parseSubscription } from "./account/accountOverview";
import {
  defaultSizeIndex,
  planRoom,
  planRoomLine,
  sizeBlockShort,
  sizeCostLine,
  sizeOptions,
} from "./newComputerSizes";

const gen2 = (slug: string, name: string, ramGb: number, diskGb = 40) => ({
  slug,
  name,
  price_usd: 20,
  generation: 2,
  base_slug: slug,
  max_box: { ram_mb: ramGb * 1024, vcpu: ramGb },
  peak: { ram_mb: ramGb * 1024, vcpu: ramGb },
  always_on: { ram_mb: ramGb * 1024, vcpu: ramGb },
  disk_gb: diskGb,
});

function plus(runningMb: number, diskUsed = 20) {
  return parseSubscription({
    plan: "plus",
    status: "active",
    price_usd: 20,
    plan_limits: gen2("plus", "Plus", 4),
    usage: { running_ram_mb: runningMb, running_vcpu: 2, disk_gb_used: diskUsed, box_count: 1 },
    plan_view: "always_on",
    always_on: { ram_mb: 4096, vcpu: 4, running_ram_mb: runningMb, running_vcpu: 2 },
  });
}

describe("new computer sizes within the plan", () => {
  it("Plus with 2 GB running: 2 GB fits, 4 GB has no room, 8 GB is over the plan", () => {
    const room = planRoom(plus(2048));
    expect(planRoomLine(room)).toBe("Your Plus: 4 GB for computers, 2 GB in use — 2 GB left.");
    const options = sizeOptions(room);
    expect(options.map((o) => [o.shape.ramMb, o.block])).toEqual([
      [2048, null],
      [4096, "no_room"],
      [8192, "too_big"],
    ]);
    expect(sizeBlockShort("no_room", room)).toBe("Only 2 GB left");
    expect(sizeBlockShort("too_big", room)).toBe("Plan max 4 GB");
    // The recommended 4 GB doesn't fit — the biggest smaller one is picked.
    const index = defaultSizeIndex(options);
    expect(options[index]!.shape).toEqual({ ramMb: 2048, vcpu: 2, diskGb: 20 });
    expect(sizeCostLine(room, options[index]!)).toBe("Included in Plus — nothing extra to pay.");
  });

  it("Plus with nothing running: 4 GB is picked, disk clamped to what is free", () => {
    const options = sizeOptions(planRoom(plus(0, 25)));
    const index = defaultSizeIndex(options);
    expect(options[index]!.shape).toEqual({ ramMb: 4096, vcpu: 2, diskGb: 15 });
  });

  it("nothing fits: says why and picks nothing", () => {
    const room = planRoom(plus(4096));
    const options = sizeOptions(room);
    expect(defaultSizeIndex(options)).toBe(-1);
    expect(sizeBlockShort("no_room", room)).toBe("Plan is in use");
    expect(sizeCostLine(room, options[0]!)).toBe(
      "4 GB of your 4 GB is running now. Put a computer to sleep, or change plan.",
    );
  });

  it("Small (1 GB a computer): every size is over the plan", () => {
    const room = planRoom(
      parseSubscription({
        plan: "small",
        status: "active",
        plan_limits: gen2("small", "Small", 1, 15),
        usage: { running_ram_mb: 0, disk_gb_used: 0 },
      }),
    );
    const options = sizeOptions(room);
    expect(options.every((o) => o.block === "too_big")).toBe(true);
    expect(sizeCostLine(room, options[0]!)).toBe("Your plan gives up to 1 GB per computer.");
  });

  it("no plan: computers come with one", () => {
    const room = planRoom(null);
    expect(room?.hasPlan).toBe(false);
    expect(sizeOptions(room).every((o) => o.block === "no_plan")).toBe(true);
    expect(planRoomLine(room)).toBeNull();
  });

  it("account not reachable: every size offered, the console stays the judge", () => {
    const room = planRoom(undefined);
    expect(room).toBeNull();
    const options = sizeOptions(room);
    expect(options.every((o) => o.block === null)).toBe(true);
    expect(options[defaultSizeIndex(options)]!.shape.ramMb).toBe(4096);
    expect(sizeCostLine(room, options[1]!)).toMatch(/Uno plan/);
  });
});
