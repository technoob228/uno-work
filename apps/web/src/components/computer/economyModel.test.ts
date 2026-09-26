import type { UnoComputerEconomy, UnoEconomyPresence } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ECONOMY_HOLD_LEAD_MS,
  economyChip,
  economyDescription,
  economyStatusLine,
  idleLabel,
  shouldHoldReconnect,
} from "./economyModel";

const economy: UnoComputerEconomy = {
  enabled: true,
  locked: false,
  source: "owner",
  idleTimeoutS: 600,
  defaultIdleTimeoutS: 600,
  state: "awake",
  sleepAfter: null,
  busy: [],
  lastSleepAt: null,
  lastWakeAt: null,
  lastWakeSource: null,
};

describe("economy chip and words", () => {
  it("chips only when on", () => {
    expect(economyChip({ ...economy, enabled: false })).toBeNull();
    expect(economyChip(undefined)).toBeNull();
    expect(economyChip(economy)?.label).toBe("Economy · awake");
    expect(economyChip({ ...economy, state: "sleeping" })?.label).toBe("Economy · sleeping");
    expect(economyChip({ ...economy, state: "waking" })?.label).toBe("Economy · waking");
  });

  it("idle labels", () => {
    expect(idleLabel(300)).toBe("5 minutes");
    expect(idleLabel(3 * 3600)).toBe("3 hours");
  });

  it("description mentions the lock on the free computer", () => {
    expect(economyDescription(economy)).toContain("after 10 minutes");
    expect(economyDescription({ ...economy, locked: true })).toContain("free computer");
  });

  it("status line", () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    expect(economyStatusLine({ ...economy, busy: ["agent:1"] }, now)).toBe(
      "Staying awake: an agent is working.",
    );
    expect(economyStatusLine({ ...economy, sleepAfter: "2026-09-25T12:04:00Z" }, now)).toBe(
      "Sleeps in 4 minutes if nothing happens.",
    );
    expect(economyStatusLine({ ...economy, state: "sleeping" }, now)).toContain("Asleep");
    expect(economyStatusLine({ ...economy, lastWakeSource: "telegram" }, now)).toBe(
      "Last woke up because a Telegram message.",
    );
    expect(economyStatusLine({ ...economy, enabled: false }, now)).toBeNull();
  });
});

describe("shouldHoldReconnect", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  const presence: UnoEconomyPresence = {
    enabled: true,
    state: "awake",
    sleepAfter: new Date(now + ECONOMY_HOLD_LEAD_MS - 1_000).toISOString(),
    idleTimeoutS: 600,
    busy: [],
    reportedAt: null,
  };

  it("holds an idle tab right before sleep", () => {
    expect(shouldHoldReconnect(presence, now - 20 * 60_000, now)).toBe(true);
    expect(shouldHoldReconnect(presence, null, now)).toBe(true);
  });

  it("lets a tab the person touched reconnect", () => {
    expect(shouldHoldReconnect(presence, now - 60_000, now)).toBe(false);
  });

  it("never holds when off, busy or far from sleep", () => {
    expect(shouldHoldReconnect({ ...presence, enabled: false }, null, now)).toBe(false);
    expect(shouldHoldReconnect({ ...presence, busy: ["agent:1"] }, null, now)).toBe(false);
    expect(
      shouldHoldReconnect(
        { ...presence, sleepAfter: new Date(now + 5 * 60_000).toISOString() },
        null,
        now,
      ),
    ).toBe(false);
    expect(shouldHoldReconnect(null, null, now)).toBe(false);
  });

  it("holds while the computer is asleep", () => {
    expect(
      shouldHoldReconnect({ ...presence, state: "sleeping", sleepAfter: null }, now, now),
    ).toBe(true);
  });
});
