import type { FoundSkill } from "@t3tools/contracts";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  agentsLine,
  droppedLabel,
  existingNames,
  foundSkillsView,
  installedAgents,
  isUnread,
  offFolderLine,
  packDropped,
} from "./skillImport";

const found = (over: Partial<FoundSkill> & Pick<FoundSkill, "name" | "scope">): FoundSkill => ({
  description: "",
  paths: [`/x/${over.name}`],
  agents: ["claude"],
  enabled: true,
  offIn: [],
  ...over,
});

describe("found skills", () => {
  it("leaves Uno's catalog to the lists below and counts what the AI uses", () => {
    const list = [
      found({ name: "deploy", scope: "project", agents: ["claude", "codex", "uno"] }),
      found({ name: "drafts", scope: "project", agents: [] }),
      found({ name: "old", scope: "project", agents: [], enabled: false }),
      found({ name: "sales-copy", scope: "computer" }),
      found({ name: "linkedin", scope: "computer", agents: ["codex"] }),
      found({ name: "parked", scope: "computer", agents: [], enabled: false }),
      found({ name: "slack-api", scope: "plugin", plugin: "slack", pluginId: "slack@m" }),
      found({ name: "slack-cli", scope: "plugin", plugin: "slack", pluginId: "slack@m" }),
    ];
    const view = foundSkillsView(list, new Set(["sales-copy"]));
    // The one with a button (Turn on) first.
    expect(view.project.map((s) => s.name)).toEqual(["drafts", "deploy", "old"]);
    expect(view.computer.map((s) => s.name)).toEqual(["linkedin", "parked"]);
    expect(view.plugins).toEqual([
      { pluginId: "slack@m", name: "slack", enabled: true, skills: [list[6], list[7]] },
    ]);
    // Off ones and the unread skills/ folder don't count.
    expect([...view.activeNames].toSorted()).toEqual([
      "deploy",
      "linkedin",
      "slack:slack-api",
      "slack:slack-cli",
    ]);
    const existing = existingNames(list, new Set(["impeccable"]));
    expect([...existing.computer].toSorted()).toEqual(["impeccable", "linkedin", "sales-copy"]);
    expect([...existing.project]).toEqual(["deploy"]);
    expect(isUnread(list[1]!)).toBe(true);
    expect(isUnread(list[2]!)).toBe(false);
    expect(
      offFolderLine(
        found({ name: "x", scope: "computer", paths: ["/h/.claude/skills-off/x"] }),
        "/h",
      ),
    ).toBe("~/.claude/skills-off");
    expect(
      offFolderLine(
        found({ name: "x", scope: "project", paths: ["/h/p/landing/.claude/skills-off/x"] }),
        "/h",
        "/h/p/landing",
      ),
    ).toBe(".claude/skills-off");
  });

  it("names only the agents this computer has", () => {
    const agents = ["claude", "codex", "uno", "opencode", "hermes"] as const;
    expect(agentsLine(agents)).toBe("Claude Code · Codex · Uno AI · OpenCode · Hermes");
    const withUno = installedAgents([
      { driver: "claudeAgent", installed: true },
      { driver: "uno", installed: true },
      { driver: "codex", installed: false },
    ]);
    expect(agentsLine(agents, withUno)).toBe("Claude Code · Uno AI");
    const plainOpenCode = installedAgents([{ driver: "opencode", installed: true }]);
    expect(agentsLine(agents, plainOpenCode)).toBe("OpenCode");
    expect(installedAgents([])).toBeNull();
  });
});

describe("packing a drop", () => {
  const file = (relativePath: string, text = "x") => {
    const blob = new Blob([text]);
    return { relativePath, size: blob.size, blob };
  };

  it("names what was dropped", () => {
    expect(droppedLabel([file("SKILL.md")])).toBe("SKILL.md");
    expect(droppedLabel([file("my-skills/a/SKILL.md"), file("my-skills/b/SKILL.md")])).toBe(
      "my-skills",
    );
    expect(droppedLabel([file("a/SKILL.md"), file("b/SKILL.md")])).toBe("2 files");
  });

  it("sends a single zip as it is and zips the rest without junk", async () => {
    const zip = file("skills.zip");
    expect(await packDropped([zip])).toBe(zip.blob);
    const packed = await packDropped([
      file("pdf/SKILL.md", "---\nname: pdf\n---"),
      file("pdf/.DS_Store"),
      file("__MACOSX/pdf/._SKILL.md"),
    ]);
    const names = Object.keys((await JSZip.loadAsync(await packed.arrayBuffer())).files);
    expect(names.filter((n) => !n.endsWith("/"))).toEqual(["pdf/SKILL.md"]);
    await expect(packDropped([file(".DS_Store")])).rejects.toThrow(/Nothing/);
  });
});
