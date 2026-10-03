import { describe, expect, it } from "vitest";

import {
  AGENTS_PROFILE_END,
  AGENTS_PROFILE_START,
  instructionsVersion,
  joinAgentsProfile,
  merge3,
  mergeInstructions,
  planInstructions,
  renderMerge,
  splitAgentsProfile,
} from "./assistantInstructions.ts";

const OLD = [
  "# Uno Assistant",
  "",
  "## Tools",
  "- list_threads",
  "",
  "## Style",
  "- brief",
  "",
].join("\n");
const NEXT = [
  "<!-- uno-instructions: v2 -->",
  "# Uno Assistant",
  "",
  "## Tools",
  "- list_threads",
  "- schedule_create",
  "",
  "## Style",
  "- brief",
  "",
].join("\n");
const PROFILE = [
  AGENTS_PROFILE_START,
  "## Who you are",
  "",
  "Your name is Ana.",
  AGENTS_PROFILE_END,
].join("\n");

describe("the profile block New assistant writes", () => {
  it("is set aside and put back", () => {
    const file = joinAgentsProfile(OLD, PROFILE);
    const { body, profile } = splitAgentsProfile(file);
    expect(profile).toBe(PROFILE);
    expect(body.trim()).toBe(OLD.trim());
    expect(splitAgentsProfile(OLD)).toEqual({ body: OLD, profile: null });
  });

  it("reads the version line", () => {
    expect(instructionsVersion(NEXT)).toBe("v2");
    expect(instructionsVersion(OLD)).toBeNull();
  });
});

describe("planInstructions", () => {
  it("seeds a missing file and its base", () => {
    expect(planInstructions({ current: null, base: null, next: NEXT, known: [] })).toEqual({
      state: "current",
      write: NEXT,
      base: NEXT,
    });
  });

  it("silently updates an untouched file, keeping the profile block", () => {
    const plan = planInstructions({
      current: joinAgentsProfile(OLD, PROFILE),
      base: OLD,
      next: NEXT,
      known: [],
    });
    expect(plan.state).toBe("current");
    expect(plan.base).toBe(NEXT);
    expect(splitAgentsProfile(plan.write!)).toMatchObject({ profile: PROFILE });
    expect(plan.write!.startsWith(NEXT.trimEnd())).toBe(true);
  });

  it("recognises an untouched file of an assistant from before bases (writeFileIfMissing)", () => {
    const plan = planInstructions({
      current: joinAgentsProfile(OLD, PROFILE),
      base: null,
      next: NEXT,
      known: [OLD],
    });
    expect(plan).toMatchObject({ state: "current", base: NEXT });
    expect(plan.write).toContain("schedule_create");
  });

  it("never touches an edited file: asks when Uno has something newer", () => {
    const edited = OLD.replace("- brief", "- brief, in Russian");
    expect(planInstructions({ current: edited, base: OLD, next: NEXT, known: [] })).toEqual({
      state: "update-available",
      write: null,
      base: null,
    });
    // Nothing newer: just "edited".
    expect(planInstructions({ current: edited, base: OLD, next: OLD, known: [] })).toEqual({
      state: "edited",
      write: null,
      base: null,
    });
    // Before bases: the closest shipped version becomes the base.
    expect(planInstructions({ current: edited, base: null, next: NEXT, known: [OLD] })).toEqual({
      state: "update-available",
      write: null,
      base: OLD,
    });
  });
});

describe("Update and keep my edits", () => {
  it("replays Uno's changes on the person's file", () => {
    const edited = OLD.replace("- brief", "- brief, in Russian");
    const { content, conflicts } = mergeInstructions({ current: edited, base: OLD, next: NEXT });
    expect(conflicts).toBe(0);
    expect(content).toContain("- schedule_create");
    expect(content).toContain("- brief, in Russian");
    expect(content).toContain("uno-instructions: v2");
  });

  it("shows a place both changed as a conflict the person resolves", () => {
    const mine = OLD.replace("- list_threads", "- list_threads (only my projects)");
    const theirs = OLD.replace("- list_threads", "- list_threads, wait_for_thread");
    const chunks = merge3(OLD, mine, theirs);
    expect(chunks.filter((chunk) => chunk.kind === "conflict")).toEqual([
      {
        kind: "conflict",
        base: ["- list_threads"],
        mine: ["- list_threads (only my projects)"],
        theirs: ["- list_threads, wait_for_thread"],
      },
    ]);
    expect(renderMerge(chunks, ["mine"])).toBe(mine);
    expect(renderMerge(chunks, ["theirs"])).toBe(theirs);
    expect(renderMerge(chunks)).toContain("(only my projects)\n- list_threads, wait_for_thread");
  });

  it("takes a change both sides made once", () => {
    const both = OLD.replace("- brief", "- brief and kind");
    expect(renderMerge(merge3(OLD, both, both))).toBe(both);
  });
});
