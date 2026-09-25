import { describe, expect, it, vi } from "vitest";

import { openAiStatusReader, parseGatewayAiStatus } from "./aiStatus.ts";

const gateway = async () => ({ baseUrl: "https://gw/v1", key: "k" });

describe("parseGatewayAiStatus", () => {
  it("reads the spec's fields", () => {
    expect(
      parseGatewayAiStatus({
        hours_left_minutes: 5220,
        power: 1,
        in_flight: 3,
        throttled: false,
        speed_pct: 100,
        renews_at: "2026-10-24T02:39:00Z",
        plan: "small-ai",
        used_today_minutes: 47,
      }),
    ).toMatchObject({
      hoursLeftMinutes: 5220,
      power: 1,
      inFlight: 3,
      throttled: false,
      speedPct: 100,
      usedTodayMinutes: 47,
      unlimited: false,
    });
  });

  it("treats less than full speed as slowed down; unlimited plans", () => {
    expect(parseGatewayAiStatus({ throttled: false, speed_pct: 40 })?.throttled).toBe(true);
    expect(
      parseGatewayAiStatus({ unlimited: true, full_speed_hours_left: 0, hours_left_minutes: null }),
    ).toMatchObject({ unlimited: true, fullSpeedHoursLeft: 0, hoursLeftMinutes: null });
    expect(parseGatewayAiStatus({ error: "x" })).toBeNull();
    expect(parseGatewayAiStatus({ enabled: false, hours_left_minutes: 0, power: 0 })).toBeNull();
    expect(parseGatewayAiStatus(null)).toBeNull();
  });
});

describe("openAiStatusReader", () => {
  it("shares one gateway call per window and backs off from a gateway without hours", async () => {
    let now = 1_000_000;
    const fetch = vi.fn(async () => new Response("not found", { status: 404 }));
    const reader = openAiStatusReader({ gateway, fetch: fetch as never, now: () => now });
    expect((await reader.read()).status).toBe("unavailable");
    now += 60_000;
    await reader.read();
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 10 * 60_000;
    await reader.read();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[0] as unknown[] | undefined)?.[0]).toBe("https://gw/v1/ai/status");
  });

  it("reads ok and no-key", async () => {
    const fetch = vi.fn(async () => Response.json({ throttled: true, speed_pct: 50, power: 1 }));
    const reader = openAiStatusReader({ gateway, fetch: fetch as never });
    expect(await reader.read()).toMatchObject({ status: "ok", throttled: true, power: 1 });
    const noKey = openAiStatusReader({ gateway: async () => null, fetch: fetch as never });
    expect((await noKey.read()).status).toBe("no-key");
  });
});
