import type { UnoSetupProgress } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  EMPTY_SETUP_PROGRESS,
  NO_PREFERENCE,
  buildAgentsMd,
  markCompleted,
  markSkipped,
  markVisited,
  mergeAgentsMd,
  nextQuestionIndex,
  parseSetupRouteStep,
  projectSlug,
  setupSidebarState,
  skipRemaining,
  tildePath,
} from "./setupModel";
import { moreSkills, offeredSkills } from "./setupSkills";
import { aiFromAccountDefault } from "./steps/AiStep";
import { mcpServerNameFromUrl } from "./steps/ConnectorsStep";

describe("setup progress", () => {
  it("hides the sidebar row until the AI path starts", () => {
    expect(setupSidebarState(EMPTY_SETUP_PROGRESS).hidden).toBe(true);
    expect(setupSidebarState({ ...EMPTY_SETUP_PROGRESS, mode: "simple" }).hidden).toBe(true);
    const started = markVisited({ ...EMPTY_SETUP_PROGRESS, mode: "ai" }, "ai");
    expect(setupSidebarState(started)).toMatchObject({ hidden: false, label: "Set up" });
  });

  it("counts done steps, not skipped ones", () => {
    let progress: UnoSetupProgress = { ...EMPTY_SETUP_PROGRESS, mode: "ai" };
    progress = markCompleted(progress, "ai");
    progress = markSkipped(progress, "project");
    progress = markCompleted(progress, "instructions");
    const state = setupSidebarState(progress);
    expect(state.meta).toBe("2/8");
    expect(state.step).toBe("skills");
  });

  it("Skip setup leaves Finish setup with what's left", () => {
    const progress = skipRemaining(markCompleted({ ...EMPTY_SETUP_PROGRESS, mode: "ai" }, "ai"));
    expect(progress.finished).toBe(true);
    const state = setupSidebarState(progress);
    expect(state).toMatchObject({ hidden: false, label: "Finish setup", meta: "6 left" });
    expect(setupSidebarState({ ...progress, dismissed: true }).hidden).toBe(true);
    // Doing a skipped step takes it off the list.
    expect(setupSidebarState(markCompleted(progress, "project")).meta).toBe("5 left");
  });

  it("parses route steps", () => {
    expect(parseSetupRouteStep("skills")).toBe("skills");
    expect(parseSetupRouteStep("tour-done")).toBe("tour-done");
    expect(parseSetupRouteStep("nope")).toBeNull();
  });
});

describe("AGENTS.md", () => {
  const base = { projectName: "candle-shop", projectFolder: "~/candle-shop", kind: "site" };

  it("shows placeholders live and leaves them out of the file", () => {
    const live = buildAgentsMd({ ...base, answers: { who: "I run a small online shop" } });
    expect(live).toContain("# AGENTS.md — candle-shop");
    expect(live).toContain("## About me\nI run a small online shop.");
    expect(live).toContain("## How to answer\n_Waiting for your answer_");
    const final = buildAgentsMd({ ...base, answers: { who: "I run a shop" }, final: true });
    expect(final).not.toContain("Waiting");
    expect(final).toContain("## On this computer");
  });

  it("writes every answer in its section", () => {
    const md = buildAgentsMd({
      ...base,
      final: true,
      answers: {
        who: "Freelance designer",
        what: "Portfolio site",
        how: "Short and to the point",
        never: "Never delete files without asking",
      },
    });
    expect(md).toContain("Website: Portfolio site. Files live in `~/candle-shop`.");
    expect(md).toContain("- Short and to the point.");
    expect(md).toContain("- Delete files without asking.");
  });

  it("drops skipped questions", () => {
    const md = buildAgentsMd({ ...base, final: true, answers: { how: NO_PREFERENCE } });
    expect(md).not.toContain("## How to answer");
    expect(nextQuestionIndex({ who: "x", what: NO_PREFERENCE })).toBe(2);
  });

  it("keeps the workspace pointer block of an existing file", () => {
    const existing =
      "old\n\n<!-- uno-workspace:begin -->\nread .t3code/UNO_WORKSPACE.md\n<!-- uno-workspace:end -->\n";
    const merged = mergeAgentsMd(existing, "# new\n");
    expect(merged.startsWith("# new")).toBe(true);
    expect(merged).toContain("<!-- uno-workspace:begin -->\nread .t3code/UNO_WORKSPACE.md");
    expect(merged).not.toContain("old");
    expect(mergeAgentsMd(null, "# new\n")).toBe("# new\n");
    expect(mergeAgentsMd("no block", "# new\n")).toBe("# new\n");
  });
});

describe("helpers", () => {
  it("slugs and shortens paths", () => {
    expect(projectSlug("  Acme Landing!! ")).toBe("acme-landing");
    expect(projectSlug("")).toBe("my-project");
    expect(tildePath("/home/u/acme", "/home/u")).toBe("~/acme");
    expect(tildePath("/srv/x", "/home/u")).toBe("/srv/x");
  });

  it("offers skills by kind of work", () => {
    expect(offeredSkills("site").map((skill) => skill.id)).toEqual([
      "up-to-date-docs",
      "impeccable",
    ]);
    expect(offeredSkills("docs")[1]?.id).toBe("presentations");
    expect(offeredSkills("bot")[1]?.id).toBe("server-safety");
    expect(offeredSkills("other")[1]?.id).toBe("sales-copy");
    expect(moreSkills("site").map((skill) => skill.id)).not.toContain("impeccable");
    expect(moreSkills("site")).toHaveLength(5);
  });

  it("names an MCP server from its address", () => {
    expect(mcpServerNameFromUrl("https://mcp.context7.com/mcp", [])).toBe("context7");
    expect(mcpServerNameFromUrl("https://mcp.context7.com/mcp", ["context7"])).toBe("context7-2");
    expect(mcpServerNameFromUrl("ftp://x.dev", [])).toBeNull();
    expect(mcpServerNameFromUrl("not a url", [])).toBeNull();
  });
});

describe("account default AI", () => {
  it("maps console values to harnesses", () => {
    expect(aiFromAccountDefault("claude")).toEqual({ id: "claudeAgent", byok: false });
    expect(aiFromAccountDefault("byok")).toEqual({ id: "opencode", byok: true });
    expect(aiFromAccountDefault(null)).toBeNull();
    expect(aiFromAccountDefault("gemini")).toBeNull();
  });
});
