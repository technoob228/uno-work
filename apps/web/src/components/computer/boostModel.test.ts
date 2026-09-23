import type { UnoComputerBoost } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { TransportConnectionLostError } from "../../rpc/transportError";
import {
  BOOST_OPTIMISTIC_MAX_MS,
  BOOST_SWITCHING_REFETCH_MS,
  boostConfirmCopy,
  boostDisabledReason,
  boostPillLabel,
  boostResetDay,
  boostRefetchMs,
  isConnectionDrop,
  minutesLeft,
  pendingSettled,
  shownBoostState,
} from "./boostModel";

const OFF: UnoComputerBoost = {
  available: true,
  state: "off",
  ramMb: 8192,
  vcpu: 4,
  baseRamMb: 4096,
  baseVcpu: 2,
  hours: 1,
  startedAt: null,
  endsAt: null,
  hoursPerMonth: 10,
  hoursUsed: 7,
  hoursLeft: 3,
  periodResetsAt: "2026-10-01T00:00:00Z",
  reason: null,
};
const NOW = Date.parse("2026-09-24T12:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

describe("boost copy", () => {
  it("says the sizes, the restart and this month's hours", () => {
    const copy = boostConfirmCopy(OFF);
    expect(copy.title).toBe("Boost this computer ×2 for 1 hour?");
    expect(copy.body).toBe(
      "4 GB → 8 GB memory and 2 → 4 cores. Your computer restarts for about 15 seconds now and again when the hour ends. A reply the AI is writing at that moment will stop; chats, files and apps come back on their own.",
    );
    expect(copy.allowance).toBe("3 of 10 boost hours left this month.");
    expect(copy.confirm).toBe("Boost for 1 hour");
  });

  it("greys the button out with Uno's reason", () => {
    expect(boostDisabledReason(OFF)).toBeNull();
    expect(boostDisabledReason({ ...OFF, available: false, reason: "Used up today" })).toBe(
      "Used up today",
    );
    expect(boostDisabledReason({ ...OFF, available: false })).toMatch(/isn't available/);
  });

  it("says when the plan has no boost hours or they are used up", () => {
    const none = { ...OFF, available: false, hoursPerMonth: 0, hoursLeft: 0, reason: "x" };
    expect(boostDisabledReason(none)).toBe("Your plan has no boost hours.");
    const usedUp = { ...OFF, available: false, hoursUsed: 10, hoursLeft: 0, reason: "x" };
    expect(boostDisabledReason(usedUp)).toBe("Boost hours are used up until Oct 1.");
    expect(boostDisabledReason({ ...usedUp, periodResetsAt: null })).toBe(
      "This month's boost hours are used up.",
    );
    // The reset is 00:00 UTC: the day is the UTC calendar day, wherever the person is.
    expect(boostResetDay("2027-01-01T00:00:00Z")).toBe("Jan 1");
    expect(boostResetDay("nope")).toBeNull();
  });
});

describe("boostPillLabel", () => {
  it("counts down in minutes and names the restarts", () => {
    expect(boostPillLabel("active", at(42.2), NOW)).toBe("Boosted ×2 · 43 min left");
    expect(boostPillLabel("active", at(0.5), NOW)).toBe("Boosted ×2 · 1 min left");
    expect(boostPillLabel("active", at(-1), NOW)).toBe("Returning to normal size…");
    expect(boostPillLabel("starting", at(60), NOW)).toBe("Restarting into boost…");
    expect(boostPillLabel("ending", null, NOW)).toBe("Returning to normal size…");
    expect(minutesLeft("not a date", NOW)).toBeNull();
  });
});

describe("waiting for the restart", () => {
  it("shows what was asked until the computer agrees", () => {
    const start = { kind: "start" as const, at: NOW, droppedAt: null };
    expect(shownBoostState(OFF, start)).toBe("starting");
    expect(pendingSettled(start, OFF, NOW + 1_000)).toBe(false);
    expect(pendingSettled(start, { ...OFF, state: "active" }, NOW + 1_000)).toBe(true);
    expect(pendingSettled(start, OFF, NOW + BOOST_OPTIMISTIC_MAX_MS + 1)).toBe(true);

    const end = { kind: "end" as const, at: NOW, droppedAt: null };
    expect(shownBoostState({ ...OFF, state: "active" }, end)).toBe("ending");
    expect(pendingSettled(end, { ...OFF, state: "ending" }, NOW)).toBe(true);
  });

  it("treats a lost connection as the restart, not as an error", () => {
    expect(isConnectionDrop(new TransportConnectionLostError())).toBe(true);
    expect(isConnectionDrop(new Error("RpcClientDefect: Unknown socket error"))).toBe(true);
    expect(isConnectionDrop(new Error("Uno can't boost right now"))).toBe(false);
  });

  it("reads the computer often while it switches or is about to", () => {
    expect(boostRefetchMs(undefined, NOW, 15_000)).toBe(15_000);
    expect(boostRefetchMs(OFF, NOW, 15_000)).toBe(15_000);
    expect(boostRefetchMs({ ...OFF, state: "starting" }, NOW, 15_000)).toBe(
      BOOST_SWITCHING_REFETCH_MS,
    );
    expect(boostRefetchMs({ ...OFF, state: "active", endsAt: at(30) }, NOW, 15_000)).toBe(15_000);
    expect(boostRefetchMs({ ...OFF, state: "active", endsAt: at(0.5) }, NOW, 15_000)).toBe(
      BOOST_SWITCHING_REFETCH_MS,
    );
  });
});
