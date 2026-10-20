/**
 * Skills already on this computer, who reads them, and turning them off and
 * on — so the setup step shows the truth ("Found in your project: 3 skills ·
 * Claude Code, Codex") and an unticked skill really is gone for every agent.
 *
 * Where each agent looks (checked against Claude Code 2.1, Codex 0.162 —
 * `codex app-server` `skills/list` — and the OpenCode docs, Oct 2026):
 *
 * | folder                         | Claude Code | Codex | Uno AI | OpenCode | Hermes |
 * |--------------------------------|-------------|-------|--------|----------|--------|
 * | ~/.claude/skills               | yes         |       | yes    | yes      | yes    |
 * | ~/.agents/skills               |             | yes   | yes    | yes      |        |
 * | $CODEX_HOME/skills (~/.codex)  |             | yes   |        |          |        |
 * | ~/.config/opencode/skills      |             |       |        | yes      |        |
 * | <project>/.claude/skills       | yes         |       | yes    | yes      |        |
 * | <project>/.agents/skills       |             | yes   | yes    | yes      |        |
 * | <project>/.codex/skills        |             | yes   |        |          |        |
 * | <project>/.opencode/skills     |             |       |        | yes      |        |
 * | Claude Code plugins' skills/   | yes         |       |        |          |        |
 *
 * Uno AI runs OpenCode with its own XDG config (unoHarnessIsolation.ts), so
 * it doesn't read ~/.config/opencode; Hermes reads ~/.claude/skills through
 * `skills.external_dirs` (HermesAcpSupport.ts). A `skills/` at the top of a
 * project is read by no agent: it's shown as "not on yet". Hidden folders
 * (Codex's own `.system`) are skipped.
 *
 * Turning a skill off: one folder (~/.claude/skills) is read by four agents,
 * and each agent's own switch (Claude's `skillOverrides`, Codex's
 * `[[skills.config]] enabled = false`, OpenCode's `permission.skill`) hides
 * it from that agent only — Hermes has none. So off = the skill's folder
 * moves next door, to `<skills folder>-off/<name>`, which no agent scans;
 * on = it moves back. Files are never deleted. Skills an agent has off in
 * its own settings are read here and shown as such (`offIn`). Plugin skills
 * can't be turned off one by one in Claude Code: the plugin goes off whole
 * (`enabledPlugins` in Claude's settings.json).
 */
import { randomBytes } from "node:crypto";
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
  readonly pluginId?: string;
  /** Plugin roots: is the plugin on in Claude Code. */
  readonly pluginEnabled?: boolean;
  /** Can a skill here be turned off by moving it to `<dir>-off`. */
  readonly switchable: boolean;
}

const MAX_SKILLS_PER_ROOT = 300;
export const OFF_SUFFIX = "-off";
const AGENT_ORDER: ReadonlyArray<SkillAgent> = ["claude", "codex", "uno", "opencode", "hermes"];

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? nodePath.join(home, path.slice(2)) : path;
}

export function offDirOf(dir: string): string {
  return `${dir}${OFF_SUFFIX}`;
}

interface Homes {
  readonly claudeDir: string;
  readonly codexHome: string;
  readonly configHome: string;
}

export function agentHomes(
  settings: Pick<ServerSettings, "providers">,
  home: string,
  env: NodeJS.ProcessEnv,
): Homes & { readonly claudeHomeSet: boolean } {
  const claudeHome = settings.providers.claudeAgent.homePath?.trim();
  const codexHome = settings.providers.codex.homePath?.trim() || env.CODEX_HOME?.trim();
  return {
    claudeDir: nodePath.join(claudeHome ? expandHome(claudeHome, home) : home, ".claude"),
    claudeHomeSet: Boolean(claudeHome),
    codexHome: codexHome ? expandHome(codexHome, home) : nodePath.join(home, ".codex"),
    configHome: env.XDG_CONFIG_HOME?.trim() || nodePath.join(home, ".config"),
  };
}

export function computerSkillRoots(
  settings: Pick<ServerSettings, "providers">,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): SkillScanRoot[] {
  const homes = agentHomes(settings, home, env);
  const shared = nodePath.join(home, ".claude", "skills");
  const root = (dir: string, agents: ReadonlyArray<SkillAgent>): SkillScanRoot => ({
    dir,
    scope: "computer",
    agents,
    switchable: true,
  });
  return [
    // With a Claude home of its own, ~/.claude/skills isn't Claude's.
    root(
      shared,
      homes.claudeHomeSet ? ["uno", "opencode", "hermes"] : ["claude", "uno", "opencode", "hermes"],
    ),
    ...(homes.claudeHomeSet ? [root(nodePath.join(homes.claudeDir, "skills"), ["claude"])] : []),
    root(nodePath.join(home, ".agents", "skills"), ["codex", "uno", "opencode"]),
    root(nodePath.join(homes.codexHome, "skills"), ["codex"]),
    root(nodePath.join(homes.configHome, "opencode", "skills"), ["opencode"]),
    root(nodePath.join(homes.configHome, "opencode", "skill"), ["opencode"]),
  ];
}

export function projectSkillRoots(projectPath: string): SkillScanRoot[] {
  const at = (...parts: string[]) => nodePath.join(projectPath, ...parts);
  const root = (
    dir: string,
    agents: ReadonlyArray<SkillAgent>,
    switchable = true,
  ): SkillScanRoot => ({
    dir,
    scope: "project",
    agents,
    switchable,
  });
  return [
    root(at(".claude", "skills"), ["claude", "uno", "opencode"]),
    root(at(".agents", "skills"), ["codex", "uno", "opencode"]),
    root(at(".codex", "skills"), ["codex"]),
    root(at(".opencode", "skills"), ["opencode"]),
    root(at(".opencode", "skill"), ["opencode"]),
    // A skills repository, or skills someone keeps in the project: no agent reads it.
    root(at("skills"), [], false),
  ];
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  return fs.readFile(path, "utf8").catch(() => null);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Installed Claude Code plugins (`plugins/installed_plugins.json`), on or off. */
export async function pluginSkillRoots(claudeDir: string): Promise<SkillScanRoot[]> {
  const installed = asRecord(
    asRecord(await readJson(nodePath.join(claudeDir, "plugins", "installed_plugins.json"))).plugins,
  );
  const enabled = asRecord(
    asRecord(await readJson(nodePath.join(claudeDir, "settings.json"))).enabledPlugins,
  );
  const roots: SkillScanRoot[] = [];
  for (const [id, installs] of Object.entries(installed)) {
    if (!Array.isArray(installs)) continue;
    const plugin = id.split("@")[0] ?? id;
    for (const install of installs) {
      const installPath = asRecord(install).installPath;
      if (typeof installPath !== "string") continue;
      roots.push({
        dir: nodePath.join(installPath, "skills"),
        scope: "plugin",
        agents: ["claude"],
        plugin,
        pluginId: id,
        pluginEnabled: enabled[id] === true,
        switchable: false,
      });
    }
  }
  return roots;
}

// ── What agents have off in their own settings ───────────────────────

export interface NativeOff {
  /** Claude Code `skillOverrides: { name: "off" }`. */
  readonly claude: ReadonlySet<string>;
  /** Codex `[[skills.config]]` with `enabled = false`, by name or SKILL.md path. */
  readonly codexNames: ReadonlySet<string>;
  readonly codexPaths: ReadonlySet<string>;
  /** OpenCode `permission.skill` patterns set to "deny". */
  readonly opencode: ReadonlyArray<RegExp>;
}

function skillOverridesOff(settings: unknown): string[] {
  return Object.entries(asRecord(asRecord(settings).skillOverrides))
    .filter(([, value]) => value === "off")
    .map(([name]) => name);
}

/** `[[skills.config]]` tables of a Codex config.toml — just `name`, `path`, `enabled`. */
export function codexSkillConfig(
  toml: string,
): Array<{ name?: string; path?: string; enabled: boolean }> {
  const out: Array<{ name?: string; path?: string; enabled: boolean }> = [];
  let current: { name?: string; path?: string; enabled: boolean } | null = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      current = /^\[\[\s*skills\.config\s*\]\]/.test(line) ? { enabled: true } : null;
      if (current) out.push(current);
      continue;
    }
    if (!current) continue;
    const match = /^(name|path|enabled)\s*=\s*(.+?)\s*(#.*)?$/.exec(line);
    if (!match) continue;
    const value = match[2]!;
    if (match[1] === "enabled") current.enabled = value !== "false";
    else {
      const str = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(value);
      if (str)
        current[match[1] as "name" | "path"] =
          str[1] !== undefined ? str[1].replace(/\\(.)/g, "$1") : (str[2] ?? "");
    }
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

function opencodeDenied(config: unknown): RegExp[] {
  return Object.entries(asRecord(asRecord(asRecord(config).permission).skill))
    .filter(([, value]) => value === "deny")
    .map(([pattern]) => globToRegExp(pattern));
}

export async function readNativeOff(input: {
  readonly homes: Homes;
  readonly projectPath?: string | undefined;
}): Promise<NativeOff> {
  const project = input.projectPath;
  const claude = [
    ...skillOverridesOff(await readJson(nodePath.join(input.homes.claudeDir, "settings.json"))),
    ...(project
      ? [
          ...skillOverridesOff(await readJson(nodePath.join(project, ".claude", "settings.json"))),
          ...skillOverridesOff(
            await readJson(nodePath.join(project, ".claude", "settings.local.json")),
          ),
        ]
      : []),
  ];
  const codex = codexSkillConfig(
    (await readText(nodePath.join(input.homes.codexHome, "config.toml"))) ?? "",
  ).filter((entry) => !entry.enabled);
  const opencode = [
    ...opencodeDenied(
      await readJson(nodePath.join(input.homes.configHome, "opencode", "opencode.json")),
    ),
    ...(project ? opencodeDenied(await readJson(nodePath.join(project, "opencode.json"))) : []),
  ];
  return {
    claude: new Set(claude),
    codexNames: new Set(codex.flatMap((entry) => (entry.name ? [entry.name] : []))),
    codexPaths: new Set(
      codex.flatMap((entry) => (entry.path ? [nodePath.resolve(entry.path)] : [])),
    ),
    opencode,
  };
}

const NO_NATIVE_OFF: NativeOff = {
  claude: new Set(),
  codexNames: new Set(),
  codexPaths: new Set(),
  opencode: [],
};

function offForAgent(agent: SkillAgent, name: string, folder: string, off: NativeOff): boolean {
  if (agent === "claude") return off.claude.has(name);
  if (agent === "codex") {
    return (
      off.codexNames.has(name) ||
      off.codexPaths.has(nodePath.join(nodePath.resolve(folder), "SKILL.md"))
    );
  }
  if (agent === "opencode") return off.opencode.some((pattern) => pattern.test(name));
  return false;
}

// ── Reading skill folders ────────────────────────────────────────────

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

interface Merged {
  name: string;
  description: string;
  scope: FoundSkillScope;
  plugin?: string;
  pluginId?: string;
  paths: string[];
  readers: Set<SkillAgent>;
  offIn: Set<SkillAgent>;
  on: boolean;
}

export async function scanSkills(input: {
  readonly roots: ReadonlyArray<SkillScanRoot>;
  readonly nativeOff?: NativeOff;
}): Promise<FoundSkill[]> {
  const nativeOff = input.nativeOff ?? NO_NATIVE_OFF;
  const merged = new Map<string, Merged>();
  const seenDirs = new Set<string>();
  const visit = async (root: SkillScanRoot, dir: string, on: boolean) => {
    const resolved = nodePath.resolve(dir);
    if (seenDirs.has(resolved)) return;
    seenDirs.add(resolved);
    for (const skill of await skillsInRoot(resolved)) {
      const key = `${root.scope}\0${root.pluginId ?? ""}\0${skill.name}`;
      let current = merged.get(key);
      if (!current) {
        current = {
          name: skill.name,
          description: skill.description,
          scope: root.scope,
          ...(root.plugin ? { plugin: root.plugin } : {}),
          ...(root.pluginId ? { pluginId: root.pluginId } : {}),
          paths: [],
          readers: new Set(),
          offIn: new Set(),
          on: false,
        };
        merged.set(key, current);
      }
      current.paths.push(skill.path);
      if (!current.description && skill.description) current.description = skill.description;
      if (!on) continue;
      current.on = true;
      for (const agent of root.agents) {
        if (offForAgent(agent, skill.name, skill.path, nativeOff)) current.offIn.add(agent);
        else current.readers.add(agent);
      }
    }
  };
  for (const root of input.roots) {
    await visit(root, root.dir, root.pluginEnabled ?? true);
    if (root.switchable) await visit(root, offDirOf(root.dir), false);
  }
  return [...merged.values()]
    .map((skill) => {
      // An agent that reads another copy isn't "off" for it.
      const offIn = AGENT_ORDER.filter(
        (agent) => skill.offIn.has(agent) && !skill.readers.has(agent),
      );
      const found: FoundSkill = {
        name: skill.name,
        description: skill.description,
        scope: skill.scope,
        paths: skill.paths,
        agents: AGENT_ORDER.filter((agent) => skill.readers.has(agent)),
        enabled: skill.on,
        offIn,
        ...(skill.plugin ? { plugin: skill.plugin } : {}),
        ...(skill.pluginId ? { pluginId: skill.pluginId } : {}),
      };
      return found;
    })
    .toSorted(
      (a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
        (a.plugin ?? "").localeCompare(b.plugin ?? "") ||
        a.name.localeCompare(b.name),
    );
}

export async function scanRootsFor(input: {
  readonly settings: Pick<ServerSettings, "providers">;
  readonly projectPath?: string | undefined;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ roots: SkillScanRoot[]; homes: Homes; project: string | undefined }> {
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  const raw = input.projectPath?.trim();
  const project = raw && nodePath.isAbsolute(raw) && (await isDirectory(raw)) ? raw : undefined;
  const homes = agentHomes(input.settings, home, env);
  return {
    roots: [
      ...(project ? projectSkillRoots(project) : []),
      ...computerSkillRoots(input.settings, home, env),
      ...(await pluginSkillRoots(homes.claudeDir)),
    ],
    homes,
    project,
  };
}

/** Everything the agents on this computer (and in the project) can use. */
export async function scanComputerSkills(input: {
  readonly settings: Pick<ServerSettings, "providers">;
  readonly projectPath?: string | undefined;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<FoundSkill[]> {
  const { roots, homes, project } = await scanRootsFor(input);
  return scanSkills({ roots, nativeOff: await readNativeOff({ homes, projectPath: project }) });
}

// ── Off and on ───────────────────────────────────────────────────────

export class SkillToggleError extends Error {
  override readonly name = "SkillToggleError";
}

function tilde(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Moves skill folders between `<root>/<name>` and `<root>-off/<name>`. Every
 * path must be a folder right inside one of the switchable roots (or its
 * `-off`) — nothing else on the computer can be moved through here.
 */
export async function setSkillsEnabled(input: {
  readonly paths: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly roots: ReadonlyArray<SkillScanRoot>;
  readonly home?: string;
}): Promise<string[]> {
  const home = input.home ?? homedir();
  const allowed = new Map<string, string>();
  for (const root of input.roots) {
    if (!root.switchable) continue;
    const on = nodePath.resolve(root.dir);
    allowed.set(on, on);
    allowed.set(offDirOf(on), on);
  }
  const moves: Array<{ from: string; to: string }> = [];
  for (const raw of input.paths) {
    const path = nodePath.resolve(raw);
    const name = nodePath.basename(path);
    const parent = nodePath.dirname(path);
    const onDir = allowed.get(parent);
    if (!onDir || name.startsWith(".") || name === "" || name.includes("\0")) {
      throw new SkillToggleError("This isn't a skill folder Uno Work can turn on or off.");
    }
    const from = nodePath.join(input.enabled ? offDirOf(onDir) : onDir, name);
    const to = nodePath.join(input.enabled ? onDir : offDirOf(onDir), name);
    if (path !== from && path !== to) continue;
    const there = await fs.lstat(from).catch(() => null);
    if (!there) continue; // already where it should be
    if (await fs.lstat(to).catch(() => null)) {
      throw new SkillToggleError(
        input.enabled
          ? `“${name}” is already on in ${tilde(onDir, home)}. Remove one of the copies first.`
          : `A turned-off copy of “${name}” is already in ${tilde(offDirOf(onDir), home)}. Remove one of them first.`,
      );
    }
    moves.push({ from, to });
  }
  const done: string[] = [];
  try {
    for (const move of moves) {
      await fs.mkdir(nodePath.dirname(move.to), { recursive: true });
      await fs.rename(move.from, move.to);
      done.push(move.to);
    }
  } catch (cause) {
    // Put back what moved, so the copies never disagree.
    for (const move of moves.slice(0, done.length).toReversed()) {
      await fs.rename(move.to, move.from).catch(() => undefined);
    }
    throw cause;
  }
  return done;
}

/** Claude Code's `enabledPlugins[pluginId]` in its settings.json, nothing else touched. */
export async function setClaudePluginEnabled(input: {
  readonly claudeDir: string;
  readonly pluginId: string;
  readonly enabled: boolean;
}): Promise<void> {
  const installed = asRecord(
    asRecord(await readJson(nodePath.join(input.claudeDir, "plugins", "installed_plugins.json")))
      .plugins,
  );
  if (!(input.pluginId in installed))
    throw new SkillToggleError("This plugin isn't installed in Claude Code.");
  const file = nodePath.join(input.claudeDir, "settings.json");
  const text = await readText(file);
  let settings: Record<string, unknown> = {};
  if (text !== null && text.trim() !== "") {
    try {
      settings = asRecord(JSON.parse(text));
    } catch {
      throw new SkillToggleError(
        "Couldn't read Claude Code's settings.json, so nothing was changed.",
      );
    }
  }
  const next = {
    ...settings,
    enabledPlugins: { ...asRecord(settings.enabledPlugins), [input.pluginId]: input.enabled },
  };
  await fs.mkdir(input.claudeDir, { recursive: true });
  const temp = `${file}.uno-${randomBytes(3).toString("hex")}`;
  const mode = (await fs.stat(file).catch(() => null))?.mode ?? 0o600;
  await fs.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: mode & 0o777 });
  await fs.rename(temp, file);
}
