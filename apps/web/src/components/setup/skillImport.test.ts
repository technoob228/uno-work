import type { FoundSkill } from "@t3tools/contracts";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  agentsLine,
  droppedLabel,
  existingNames,
  foundSkillsView,
  packDropped,
} from "./skillImport";

const found = (over: Partial<FoundSkill> & Pick<FoundSkill, "name" | "scope">): FoundSkill => ({
  description: "",
  paths: [`/x/${over.name}`],
  agents: ["claude"],
  ...over,
});

describe("found skills", () => {
  it("leaves Uno's catalog to the lists below and counts what the AI uses", () => {
    const list = [
      found({ name: "deploy", scope: "project", agents: ["claude", "codex", "opencode"] }),
      found({ name: "drafts", scope: "project", agents: [] }),
      found({ name: "sales-copy", scope: "computer" }),
      found({ name: "linkedin", scope: "computer", agents: ["codex"] }),
      found({ name: "slack-api", scope: "plugin", plugin: "slack" }),
    ];
    const view = foundSkillsView(list, new Set(["sales-copy"]));
    expect(view.project.map((s) => s.name)).toEqual(["drafts", "deploy"]);
    expect(view.computer.map((s) => s.name)).toEqual(["linkedin", "slack-api"]);
    expect([...view.activeNames].toSorted()).toEqual(["deploy", "linkedin", "slack:slack-api"]);
    const existing = existingNames(list, new Set(["impeccable"]));
    expect([...existing.computer].toSorted()).toEqual(["impeccable", "linkedin", "sales-copy"]);
    expect([...existing.project]).toEqual(["deploy"]);
    expect(agentsLine(["claude", "codex", "opencode"])).toBe("Claude Code · Codex · Uno AI");
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
