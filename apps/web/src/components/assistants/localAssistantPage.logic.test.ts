import { describe, expect, it } from "vitest";

import { connectorLevels, jobFromSoul, suggestsOwnComputer } from "./LocalAssistantPage";

describe("an assistant on this computer", () => {
  it("highlights its own computer for templates that read strangers' mail and sites", () => {
    expect(suggestsOwnComputer("marketing")).toBe(true);
    expect(suggestsOwnComputer("support")).toBe(true);
    expect(suggestsOwnComputer("personal")).toBe(false);
    expect(suggestsOwnComputer(null)).toBe(false);
  });

  it("moves with its job and its apps (unset = full access)", () => {
    expect(jobFromSoul("# Who I am\n\n## My job\nAnswer customers.\n\n## Rules\n- x")).toBe(
      "Answer customers.",
    );
    expect(jobFromSoul("# Who I am")).toBeNull();
    expect(connectorLevels({ gmail: "none" })).toEqual({
      gmail: "none",
      "google-drive": "write",
      notion: "write",
      github: "write",
    });
  });
});
