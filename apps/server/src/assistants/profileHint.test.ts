import type { ManagerAssistantTeam } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildAssistantContextHint } from "../provider/acp/hermesHandoff.ts";
import { assistantProfileBlock } from "./profileHint.ts";
import { EMPTY_TEAM } from "./teamStore.ts";

export const profileHintFixtureTeam: ManagerAssistantTeam = {
  ...EMPTY_TEAM,
  roles: ["Dev"],
  duties: ["Watch CI on fishcode", "Morning plan at 9"],
};

describe("its duties and rules in its system prompt", () => {
  it("lists its duties, role, email rules and where the person wants it", () => {
    const block = assistantProfileBlock(
      { ...profileHintFixtureTeam, worksOnWish: "cloud" },
      { isUno: false },
    )!;
    expect(block).toContain("- Watch CI on fishcode\n- Morning plan at 9");
    expect(block).toContain("Your role: Dev.");
    expect(block).toContain("Writes to anyone · up to 50 letters a day");
    expect(block).toContain("one of their cloud computers");
    const off = assistantProfileBlock(
      { ...EMPTY_TEAM, mail: { ...EMPTY_TEAM.mail, enabled: false } },
      { isUno: true },
    )!;
    expect(off).toContain("Your own email is off");
    expect(off).not.toContain("standing duties");
  });

  it("goes into the hint first, even with no files", () => {
    const hint = buildAssistantContextHint({
      soul: "",
      user: "",
      notes: "",
      routing: "",
      profile: assistantProfileBlock(profileHintFixtureTeam, { isUno: false }),
      readAt: "2026-10-22T08:00:00Z",
    });
    expect(hint?.hint).toContain("<Your profile — Uno Work keeps it");
    expect(hint?.hint).toContain("Watch CI on fishcode");
    expect(hint?.withNotes).toBe(false);
    expect(
      buildAssistantContextHint({ soul: "", user: "", notes: "", routing: "", readAt: "x" }),
    ).toBeNull();
  });
});
