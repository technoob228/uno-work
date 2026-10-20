/**
 * Skills already on this computer, and who reads them — so the setup step
 * shows the truth ("Found in your project: 3 skills · Claude Code, Codex").
 *
 * Where each agent looks (checked against Claude Code 2.1, Codex 0.162 —
 * `codex app-server` `skills/list` — and the OpenCode docs, Oct 2026):
 *
 * | folder                         | Claude Code | Codex | OpenCode / Uno |
 * |--------------------------------|-------------|-------|----------------|
 * | ~/.claude/skills               | yes         |       | yes            |
 * | ~/.agents/skills               |             | yes   | yes            |
 * | $CODEX_HOME/skills (~/.codex)  |             | yes   |                |
 * | ~/.config/opencode/skills      |             |       | yes            |
 * | <project>/.claude/skills       | yes         |       | yes            |
 * | <project>/.agents/skills       |             | yes   | yes            |
 * | <project>/.codex/skills        |             | yes   |                |
 * | <project>/.opencode/skills     |             |       | yes            |
 * | Claude Code plugins' skills/   | yes         |       |                |
 *
 * Hermes reads `~/.claude/skills` (HermesAcpSupport.ts). A `skills/` at the
 * top of a project is read by no agent: it's shown as "not on yet".
 * Hidden folders (Codex's own `.system`) are skipped.
 */
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import type { FoundSkill, FoundSkillScope, ServerSettings, SkillAgent } from "@t3tools/contracts";

import { parseSkillManifest, SKILL_MD_MAX_BYTES } from "./skillManifest.ts";

export interface SkillScanRoot {
  readonly dir: string;
  readonly scope: FoundSkillScope;
  readonly agents: ReadonlyArray<SkillAgent>;
  readonly plugin?: string;
}

const MAX_SKILLS_PER_ROOT = 300;

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? nodePath.join(home, path.slice(2)) : path;
}

export function computerSkillRoots(
  settings: Pick<ServerSettings, "providers">,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): SkillScanRoot[] {
  const claudeHome = settings.providers.claudeAgent.homePath?.trim();
  const codexHome = settings.providers.codex.homePath?.trim() || env.CODEX_HOME?.trim();
  const config = env.XDG_CONFIG_HOME?.trim() || nodePath.join(home, ".config");
  const claudeDir = claudeHome
    ? nodePath.join(expandHome(claudeHome, home), ".claude", "skills")
    : null;
  return [
    // With a Claude home of its own, ~/.claude/skills is OpenCode's only.
    {
      dir: nodePath.join(home, ".claude", "skills"),
      scope: "computer",
      agents: claudeDir ? ["opencode"] : ["claude", "opencode"],
    },
    ...(claudeDir ? [{ dir: claudeDir, scope: "computer", agents: ["claude"] } as const] : []),
    {
      dir: nodePath.join(home, ".agents", "skills"),
      scope: "computer",
      agents: ["codex", "opencode"],
    },
    {
      dir: nodePath.join(
        codexHome ? expandHome(codexHome, home) : nodePath.join(home, ".codex"),
        "skills",
      ),
      scope: "computer",
      agents: ["codex"],
    },
    { dir: nodePath.join(config, "opencode", "skills"), scope: "computer", agents: ["opencode"] },
    { dir: nodePath.join(config, "opencode", "skill"), scope: "computer", agents: ["opencode"] },
  ];
}

export function projectSkillRoots(projectPath: string): SkillScanRoot[] {
  const at = (...parts: string[]) => nodePath.join(projectPath, ...parts);
  return [
    { dir: at(".claude", "skills"), scope: "project", agents: ["claude", "opencode"] },
    { dir: at(".agents", "skills"), scope: "project", agents: ["codex", "opencode"] },
    { dir: at(".codex", "skills"), scope: "project", agents: ["codex"] },
    { dir: at(".opencode", "skills"), scope: "project", agents: ["opencode"] },
    { dir: at(".opencode", "skill"), scope: "project", agents: ["opencode"] },
    // A skills repository, or skills someone keeps in the project: no agent reads it.
    { dir: at("skills"), scope: "project", agents: [] },
  ];
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Enabled Claude Code plugins (`~/.claude/plugins/installed_plugins.json`) and their skills/. */
export async function pluginSkillRoots(claudeDir: string): Promise<SkillScanRoot[]> {
  const installed = (await readJson(
    nodePath.join(claudeDir, "plugins", "installed_plugins.json"),
  )) as {
    plugins?: Record<string, Array<{ installPath?: unknown }>>;
  } | null;
  const settings = (await readJson(nodePath.join(claudeDir, "settings.json"))) as {
    enabledPlugins?: Record<string, unknown>;
  } | null;
  const enabled = settings?.enabledPlugins ?? {};
  const roots: SkillScanRoot[] = [];
  for (const [id, installs] of Object.entries(installed?.plugins ?? {})) {
    if (enabled[id] !== true || !Array.isArray(installs)) continue;
    const plugin = id.split("@")[0] ?? id;
    for (const install of installs) {
      if (typeof install?.installPath !== "string") continue;
      roots.push({
        dir: nodePath.join(install.installPath, "skills"),
        scope: "plugin",
        agents: ["claude"],
        plugin,
      });
    }
  }
  return roots;
}

interface RootSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

async function isDirectory(path: string): Promise<boolean> {
  return fs
    .stat(path)
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}

/** `<root>/<folder>/SKILL.md` — the layout every agent reads (symlinked folders too). */
export async function skillsInRoot(dir: string): Promise<RootSkill[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: RootSkill[] = [];
  for (const entry of entries) {
    if (out.length >= MAX_SKILLS_PER_ROOT) break;
    if (entry.name.startsWith(".")) continue;
    const folder = nodePath.join(dir, entry.name);
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDirectory(folder)))) continue;
    const file = nodePath.join(folder, "SKILL.md");
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    const handle = await fs.open(file, "r").catch(() => null);
    if (!handle) continue;
    let text = "";
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, SKILL_MD_MAX_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
    const manifest = parseSkillManifest(text);
    out.push({
      name: manifest?.name ?? entry.name,
      description: manifest?.description ?? "",
      path: folder,
    });
  }
  return out;
}

const SCOPE_ORDER: Record<FoundSkillScope, number> = { project: 0, computer: 1, plugin: 2 };

export async function scanSkills(input: {
  readonly roots: ReadonlyArray<SkillScanRoot>;
}): Promise<FoundSkill[]> {
  const merged = new Map<
    string,
    {
      name: string;
      description: string;
      scope: FoundSkillScope;
      plugin?: string;
      paths: string[];
      agents: Set<SkillAgent>;
    }
  >();
  const seenDirs = new Set<string>();
  for (const root of input.roots) {
    const resolved = nodePath.resolve(root.dir);
    if (seenDirs.has(resolved)) continue;
    seenDirs.add(resolved);
    for (const skill of await skillsInRoot(resolved)) {
      const key = `${root.scope}\0${root.plugin ?? ""}\0${skill.name}`;
      const current = merged.get(key);
      if (current) {
        current.paths.push(skill.path);
        for (const agent of root.agents) current.agents.add(agent);
        if (!current.description && skill.description) current.description = skill.description;
        continue;
      }
      merged.set(key, {
        name: skill.name,
        description: skill.description,
        scope: root.scope,
        ...(root.plugin ? { plugin: root.plugin } : {}),
        paths: [skill.path],
        agents: new Set(root.agents),
      });
    }
  }
  return [...merged.values()]
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      paths: skill.paths,
      agents: (["claude", "codex", "opencode"] as const).filter((agent) => skill.agents.has(agent)),
      ...(skill.plugin ? { plugin: skill.plugin } : {}),
    }))
    .toSorted(
      (a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
        (a.plugin ?? "").localeCompare(b.plugin ?? "") ||
        a.name.localeCompare(b.name),
    );
}

/** Everything the agents on this computer (and in the project) can use. */
export async function scanComputerSkills(input: {
  readonly settings: Pick<ServerSettings, "providers">;
  readonly projectPath?: string | undefined;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<FoundSkill[]> {
  const home = input.home ?? homedir();
  const project = input.projectPath?.trim();
  const claudeHome = input.settings.providers.claudeAgent.homePath?.trim();
  const claudeDir = nodePath.join(claudeHome ? expandHome(claudeHome, home) : home, ".claude");
  const roots = [
    ...(project && nodePath.isAbsolute(project) && (await isDirectory(project))
      ? projectSkillRoots(project)
      : []),
    ...computerSkillRoots(input.settings, home, input.env ?? process.env),
    ...(await pluginSkillRoots(claudeDir)),
  ];
  return scanSkills({ roots });
}
