import { describe, expect, it } from "vitest";

import { describeWorkRestartError, parseWorkRestart } from "./accountOverview";
import { AccountHttpError } from "./unoAccount";

describe("restart only Uno Work", () => {
  it("reads the console's answer", () => {
    expect(parseWorkRestart({ state: "done", requested_at: "2026-11-11T12:00:00Z" })).toEqual({
      state: "done",
      error: null,
    });
    expect(
      parseWorkRestart({
        state: "failed",
        error: "Uno Work didn't restart. Restart the computer instead.",
      }),
    ).toEqual({ state: "failed", error: "Uno Work didn't restart. Restart the computer instead." });
    expect(parseWorkRestart({ state: "restarting" })?.state).toBe("restarting");
    expect(parseWorkRestart(null)).toBeNull();
    expect(parseWorkRestart({ state: "weird" })).toBeNull();
  });

  it("says the console's own words for a refusal", () => {
    const tooSoon = new AccountHttpError(429, "429: …", {
      error: "WORK_RESTART_TOO_SOON",
      detail: "Uno Work on this computer was restarted a moment ago. Try again in half a minute.",
    });
    expect(describeWorkRestartError(tooSoon)).toBe(
      "Uno Work on this computer was restarted a moment ago. Try again in half a minute.",
    );
    // An older console without the endpoint.
    expect(
      describeWorkRestartError(
        new AccountHttpError(404, "404: 404 page not found", "404 page not found"),
      ),
    ).toBe("Uno can't restart Uno Work on this computer yet.");
  });
});
