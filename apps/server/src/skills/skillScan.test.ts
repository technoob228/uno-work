import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  codexSkillConfig,
  scanComputerSkills,
  scanRootsFor,
  setClaudePluginEnabled,
  setSkillsEnabled,
} from "./skillScan.ts";

function skill(dir: string, name: string, description = `About ${name}.`) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    nodePath.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

function fixture() {
  const base = mkdtempSync(nodePath.join(tmpdir(), "uno-skill-scan-"));
  const home = nodePath.join(base, "home");
  const project = nodePath.join(base, "project");
  // The catalog installer writes both copies: one row, every reader.
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
    JSON.stringify({ model: "opus", enabledPlugins: { "feature-dev@m": true, "off@m": false } }),
  );
  return { base, home, project };
}

const scan = (home: string, project?: string) =>
  scanComputerSkills({ settings: DEFAULT_SERVER_SETTINGS, projectPath: project, home, env: {} });

describe("skill scan", () => {
  it("finds project, computer and plugin skills and says who reads them", async () => {
    const { home, project } = fixture();
    const found = await scan(home, project);
    const brief = found.map((s) => [s.scope, s.name, s.agents.join(","), s.enabled]);
    expect(brief).toEqual([
      ["project", "deploy", "claude,codex,uno,opencode", true],
      ["project", "drafts", "", true],
      ["computer", "linked", "claude,uno,opencode,hermes", true],
      ["computer", "linkedin", "codex,uno,opencode", true],
      ["computer", "sales-copy", "claude,codex,uno,opencode,hermes", true],
      ["plugin", "feature-dev", "claude", true],
      ["plugin", "off-skill", "", false],
    ]);
    expect(found.find((s) => s.name === "sales-copy")!.paths).toHaveLength(2);
    expect(found.find((s) => s.name === "feature-dev")).toMatchObject({
      plugin: "feature-dev",
      pluginId: "feature-dev@m",
    });
  });

  it("works without a project and on an empty computer", async () => {
    const home = mkdtempSync(nodePath.join(tmpdir(), "uno-skill-scan-empty-"));
    expect(await scan(home, "/nope")).toEqual([]);
  });

  it("shows what agents have off in their own settings", async () => {
    const { home, project } = fixture();
    writeFileSync(
      nodePath.join(home, ".claude", "settings.json"),
      JSON.stringify({ skillOverrides: { linked: "off", other: "name-only" } }),
    );
    mkdirSync(nodePath.join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      nodePath.join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ permission: { skill: { "link*": "deny" } } }),
    );
    writeFileSync(
      nodePath.join(home, ".codex", "config.toml"),
      [
        'model = "gpt-6"',
        "[[skills.config]]",
        'name = "linkedin"',
        "enabled = false",
        "",
        "[[skills.config]]",
        `path = "${nodePath.join(project, ".agents", "skills", "deploy", "SKILL.md")}"`,
        "enabled = false",
      ].join("\n"),
    );
    const found = await scan(home, project);
    const pick = (name: string) => found.find((s) => s.name === name)!;
    expect(pick("linked")).toMatchObject({
      agents: ["uno", "hermes"],
      offIn: ["claude", "opencode"],
    });
    expect(pick("linkedin")).toMatchObject({ agents: ["uno"], offIn: ["codex", "opencode"] });
    expect(pick("deploy")).toMatchObject({
      agents: ["claude", "uno", "opencode"],
      offIn: ["codex"],
    });
  });

  it("reads Codex's [[skills.config]] tables", () => {
    expect(
      codexSkillConfig('[[skills.config]]\nname = "a" # x\nenabled = false\n[other]\nname = "b"\n'),
    ).toEqual([{ name: "a", enabled: false }]);
  });
});

describe("turning skills off and on", () => {
  it("moves every copy next door and back, files kept", async () => {
    const { home, project } = fixture();
    const { roots } = await scanRootsFor({
      settings: DEFAULT_SERVER_SETTINGS,
      projectPath: project,
      home,
      env: {},
    });
    const deploy = (await scan(home, project)).find((s) => s.name === "deploy")!;

    const moved = await setSkillsEnabled({ paths: deploy.paths, enabled: false, roots, home });
    expect(moved.toSorted()).toEqual([
      nodePath.join(project, ".agents", "skills-off", "deploy"),
      nodePath.join(project, ".claude", "skills-off", "deploy"),
    ]);
    expect(existsSync(nodePath.join(project, ".claude", "skills", "deploy"))).toBe(false);
    const off = (await scan(home, project)).find((s) => s.name === "deploy")!;
    expect(off).toMatchObject({ enabled: false, agents: [] });

    await setSkillsEnabled({ paths: off.paths, enabled: true, roots, home });
    expect(
      readFileSync(nodePath.join(project, ".claude", "skills", "deploy", "SKILL.md"), "utf8"),
    ).toContain("deploy");
    expect((await scan(home, project)).find((s) => s.name === "deploy")).toMatchObject({
      enabled: true,
    });
  });

  it("turns off a linked skill folder by moving the link, not its target", async () => {
    const { base, home } = fixture();
    const { roots } = await scanRootsFor({ settings: DEFAULT_SERVER_SETTINGS, home, env: {} });
    await setSkillsEnabled({
      paths: [nodePath.join(home, ".claude", "skills", "linked")],
      enabled: false,
      roots,
      home,
    });
    expect(existsSync(nodePath.join(base, "elsewhere", "linked", "SKILL.md"))).toBe(true);
    expect(existsSync(nodePath.join(home, ".claude", "skills-off", "linked", "SKILL.md"))).toBe(
      true,
    );
  });

  it("refuses anything outside the skills folders and won't overwrite a copy", async () => {
    const { home, project } = fixture();
    const { roots } = await scanRootsFor({
      settings: DEFAULT_SERVER_SETTINGS,
      projectPath: project,
      home,
      env: {},
    });
    await expect(
      setSkillsEnabled({ paths: [nodePath.join(home, ".ssh")], enabled: false, roots, home }),
    ).rejects.toThrow(/isn't a skill folder/);
    await expect(
      setSkillsEnabled({
        paths: [nodePath.join(project, "skills", "drafts")],
        enabled: false,
        roots,
        home,
      }),
    ).rejects.toThrow(/isn't a skill folder/);
    skill(nodePath.join(home, ".agents", "skills-off", "linkedin"), "linkedin");
    await expect(
      setSkillsEnabled({
        paths: [nodePath.join(home, ".agents", "skills", "linkedin")],
        enabled: false,
        roots,
        home,
      }),
    ).rejects.toThrow(/already in ~\/\.agents\/skills-off/);
  });

  it("turns a Claude plugin off whole, keeping the rest of settings.json", async () => {
    const { home } = fixture();
    const claudeDir = nodePath.join(home, ".claude");
    await setClaudePluginEnabled({ claudeDir, pluginId: "feature-dev@m", enabled: false });
    const settings = JSON.parse(readFileSync(nodePath.join(claudeDir, "settings.json"), "utf8"));
    expect(settings).toEqual({
      model: "opus",
      enabledPlugins: { "feature-dev@m": false, "off@m": false },
    });
    expect((await scan(home)).find((s) => s.name === "feature-dev")).toMatchObject({
      enabled: false,
      agents: [],
    });
    await expect(
      setClaudePluginEnabled({ claudeDir, pluginId: "nope@m", enabled: true }),
    ).rejects.toThrow(/isn't installed/);
    writeFileSync(nodePath.join(claudeDir, "settings.json"), "{ broken");
    await expect(
      setClaudePluginEnabled({ claudeDir, pluginId: "off@m", enabled: true }),
    ).rejects.toThrow(/nothing was changed/);
  });
});
