import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  installSkill,
  installedSkills,
  listCatalogSkills,
  removeSkill,
  skillTargetRoots,
} from "./skillInstaller.ts";

function fixture() {
  const base = mkdtempSync(nodePath.join(tmpdir(), "uno-skills-"));
  const home = nodePath.join(base, "home");
  const catalog = nodePath.join(base, "catalog");
  mkdirSync(nodePath.join(catalog, "sales-copy", "reference"), { recursive: true });
  writeFileSync(nodePath.join(catalog, "sales-copy", "SKILL.md"), "---\nname: sales-copy\n---\n");
  writeFileSync(nodePath.join(catalog, "sales-copy", "LICENSE"), "MIT");
  writeFileSync(nodePath.join(catalog, "sales-copy", "reference", "a.md"), "ref");
  mkdirSync(nodePath.join(catalog, "no-skill-md"), { recursive: true });
  return { home, catalog };
}

describe("skill installer", () => {
  it("targets Claude's and Codex's folders, honouring homePath overrides", () => {
    expect(skillTargetRoots(DEFAULT_SERVER_SETTINGS, "/h")).toEqual([
      "/h/.claude/skills",
      "/h/.codex/skills",
    ]);
    const custom = {
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          homePath: "~/claude-home",
        },
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: "/opt/codex" },
      },
    };
    expect(skillTargetRoots(custom, "/h")).toEqual([
      "/h/.claude/skills",
      "/h/claude-home/.claude/skills",
      "/opt/codex/skills",
    ]);
  });

  it("lists only folders with a SKILL.md", async () => {
    const { catalog } = fixture();
    expect(await listCatalogSkills(catalog)).toEqual(["sales-copy"]);
    expect(await listCatalogSkills(undefined)).toEqual([]);
  });

  it("copies the whole folder into every root, then removes it", async () => {
    const { home, catalog } = fixture();
    const roots = skillTargetRoots(DEFAULT_SERVER_SETTINGS, home);
    const paths = await installSkill({ id: "sales-copy", catalogDir: catalog, roots });
    expect(paths).toHaveLength(2);
    for (const root of roots) {
      expect(readFileSync(nodePath.join(root, "sales-copy", "LICENSE"), "utf8")).toBe("MIT");
      expect(existsSync(nodePath.join(root, "sales-copy", "reference", "a.md"))).toBe(true);
    }
    expect(await installedSkills(["sales-copy", "impeccable"], roots)).toEqual(["sales-copy"]);
    // Reinstall replaces cleanly.
    await installSkill({ id: "sales-copy", catalogDir: catalog, roots });
    await removeSkill({ id: "sales-copy", roots });
    expect(await installedSkills(["sales-copy"], roots)).toEqual([]);
  });

  it("refuses unknown or unsafe ids", async () => {
    const { home, catalog } = fixture();
    const roots = skillTargetRoots(DEFAULT_SERVER_SETTINGS, home);
    await expect(installSkill({ id: "../etc", catalogDir: catalog, roots })).rejects.toThrow();
    await expect(installSkill({ id: "missing", catalogDir: catalog, roots })).rejects.toThrow();
    await expect(removeSkill({ id: "../x", roots })).rejects.toThrow();
  });
});
