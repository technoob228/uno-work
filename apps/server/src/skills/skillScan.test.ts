import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { scanComputerSkills } from "./skillScan.ts";

function skill(dir: string, name: string, description = `About ${name}.`) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    nodePath.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

describe("skill scan", () => {
  it("finds project, computer and plugin skills and says who reads them", async () => {
    const base = mkdtempSync(nodePath.join(tmpdir(), "uno-skill-scan-"));
    const home = nodePath.join(base, "home");
    const project = nodePath.join(base, "project");
    // The catalog installer writes both copies: one row, both agents.
    skill(nodePath.join(home, ".claude", "skills", "sales-copy"), "sales-copy");
    skill(nodePath.join(home, ".codex", "skills", "sales-copy"), "sales-copy");
    skill(nodePath.join(home, ".codex", "skills", ".system", "imagegen"), "imagegen");
    skill(nodePath.join(home, ".agents", "skills", "linkedin"), "linkedin");
    // A skill folder can be a link to somewhere else.
    skill(nodePath.join(base, "elsewhere", "linked"), "linked");
    symlinkSync(
      nodePath.join(base, "elsewhere", "linked"),
      nodePath.join(home, ".claude", "skills", "linked"),
    );
    // A stray SKILL.md at the top of the folder is not a skill.
    writeFileSync(nodePath.join(home, ".claude", "skills", "SKILL.md"), "---\nname: stray\n---\n");
    skill(nodePath.join(project, ".claude", "skills", "deploy"), "deploy");
    skill(nodePath.join(project, ".agents", "skills", "deploy"), "deploy");
    skill(nodePath.join(project, "skills", "drafts"), "drafts");
    const plugin = nodePath.join(home, ".claude", "plugins", "cache", "m", "feature-dev", "1");
    skill(nodePath.join(plugin, "skills", "feature-dev"), "feature-dev");
    const off = nodePath.join(home, ".claude", "plugins", "cache", "m", "off", "1");
    skill(nodePath.join(off, "skills", "off-skill"), "off-skill");
    writeFileSync(
      nodePath.join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "feature-dev@m": [{ installPath: plugin }],
          "off@m": [{ installPath: off }],
        },
      }),
    );
    writeFileSync(
      nodePath.join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "feature-dev@m": true, "off@m": false } }),
    );

    const found = await scanComputerSkills({
      settings: DEFAULT_SERVER_SETTINGS,
      projectPath: project,
      home,
      env: {},
    });
    const brief = found.map((s) => [s.scope, s.name, s.agents.join(",")]);
    expect(brief).toEqual([
      ["project", "deploy", "claude,codex,opencode"],
      ["project", "drafts", ""],
      ["computer", "linked", "claude,opencode"],
      ["computer", "linkedin", "codex,opencode"],
      ["computer", "sales-copy", "claude,codex,opencode"],
      ["plugin", "feature-dev", "claude"],
    ]);
    expect(found.find((s) => s.name === "sales-copy")!.paths).toHaveLength(2);
    expect(found.find((s) => s.name === "feature-dev")!.plugin).toBe("feature-dev");
  });

  it("works without a project and on an empty computer", async () => {
    const home = mkdtempSync(nodePath.join(tmpdir(), "uno-skill-scan-empty-"));
    expect(
      await scanComputerSkills({
        settings: DEFAULT_SERVER_SETTINGS,
        projectPath: "/nope",
        home,
        env: {},
      }),
    ).toEqual([]);
  });
});
