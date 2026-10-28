import { describe, expect, it } from "vitest";

import { capabilitiesFoundAccount } from "./ClaudeDriver.ts";

/**
 * P3 (cap walkthrough 28.10): a probe taken before the sign-in found no
 * account and was kept for 5 minutes, so the refresh right after the sign-in
 * still read "no plan" and Settings → AI asked to sign in to Claude again.
 * Only a probe that saw an account is worth keeping.
 */
describe("which Claude capability probes are kept", () => {
  it("drops a probe that ran signed out", () => {
    expect(capabilitiesFoundAccount({})).toBe(false);
    expect(
      capabilitiesFoundAccount({ email: undefined, subscriptionType: undefined, tokenSource: "" }),
    ).toBe(false);
  });

  it("keeps a probe that saw the plan, the account or the token's source", () => {
    expect(capabilitiesFoundAccount({ subscriptionType: "max" })).toBe(true);
    expect(capabilitiesFoundAccount({ email: "a@b.c" })).toBe(true);
    expect(capabilitiesFoundAccount({ tokenSource: "ANTHROPIC_API_KEY" })).toBe(true);
  });
});
