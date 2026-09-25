import { describe, expect, it } from "vitest";

import {
  economyIdleLabel,
  parseComputerEconomy,
  setComputerEconomy,
} from "./unoComputerEconomy.ts";

describe("unoComputerEconomy", () => {
  it("parses the console object and ignores junk", () => {
    expect(parseComputerEconomy(undefined)).toBeNull();
    expect(parseComputerEconomy({ state: "awake" })).toBeNull();
    expect(
      parseComputerEconomy({
        enabled: true,
        locked: true,
        source: "plan",
        idle_timeout_s: 600,
        default_idle_timeout_s: 600,
        state: "sleeping",
        sleep_after: null,
        busy: ["agent:1", 7],
        last_wake_source: "telegram",
      }),
    ).toEqual({
      enabled: true,
      locked: true,
      source: "plan",
      idleTimeoutS: 600,
      defaultIdleTimeoutS: 600,
      state: "sleeping",
      sleepAfter: null,
      busy: ["agent:1"],
      lastSleepAt: null,
      lastWakeAt: null,
      lastWakeSource: "telegram",
    });
  });

  it("words the idle timer", () => {
    expect(economyIdleLabel(600)).toBe("10 minutes");
    expect(economyIdleLabel(3600)).toBe("1 hour");
    expect(economyIdleLabel(7200)).toBe("2 hours");
    expect(economyIdleLabel(60)).toBe("1 minute");
  });

  it("PATCHes and explains refusals", async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
    const ok = await setComputerEconomy({
      apiKey: "uno_agt_x",
      boxId: 7,
      enabled: false,
      fetchJson: async (_key, path, init) => {
        calls.push({ path, init });
        return { enabled: false, state: "off", idle_timeout_s: 600 };
      },
    });
    expect(ok.enabled).toBe(false);
    expect(calls[0]?.path).toBe("/api/v1/boxes/7/economy");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ enabled: false });

    await expect(
      setComputerEconomy({
        apiKey: "k",
        boxId: 7,
        enabled: false,
        fetchJson: async () => {
          throw new Error('409 {"error":"ECONOMY_MODE_LOCKED","detail":"x"}');
        },
      }),
    ).rejects.toThrow(/free computer always runs in economy mode/);
    await expect(setComputerEconomy({ apiKey: "", boxId: 7 })).rejects.toThrow();
    await expect(setComputerEconomy({ apiKey: "k", boxId: null })).rejects.toThrow();
  });
});
