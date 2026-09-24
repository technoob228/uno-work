/**
 * Installs the skills that ship with Uno Work (the web client's `skills/`
 * assets, served from the same `dist/client` as the UI, so it works offline)
 * for every agent on this machine. Where each one looks:
 *
 * - Claude Code: `$HOME/.claude/skills/<id>/` (HOME moves only when the Claude
 *   `homePath` setting is set — see ClaudeHome.ts);
 * - OpenCode and Uno (uno-code, an opencode fork): scan `~/.claude/skills/`
 *   (and `~/.agents/skills/`);
 * - Codex: `$CODEX_HOME/skills/<id>/` (`~/.codex` unless `homePath` is set);
 * - Hermes: runs in a per-thread HERMES_HOME; its config.yaml points
 *   `skills.external_dirs` at `~/.claude/skills` (HermesAcpSupport.ts).
 *
 * So one install = the folder copied whole (LICENSE, NOTICE, references and
 * scripts included) into Claude's and Codex's folders. Copies, not links:
 * not every agent follows symlinks when it scans for SKILL.md.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import { SKILL_ID_PATTERN, type ServerSettings } from "@t3tools/contracts";

/** `~/.claude/skills` of the daemon's user: the folder every agent family can read. */
export function sharedSkillsRoot(home: string = homedir()): string {
  return nodePath.join(home, ".claude", "skills");
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? nodePath.join(home, path.slice(2)) : path;
}

/** Skill folders the agents read, first = the one checked for "installed". */
export function skillTargetRoots(
  settings: Pick<ServerSettings, "providers">,
  home: string = homedir(),
): ReadonlyArray<string> {
  const claudeHome = settings.providers.claudeAgent.homePath?.trim();
  const codexHome = settings.providers.codex.homePath?.trim();
  const roots = [
    sharedSkillsRoot(home),
    ...(claudeHome ? [nodePath.join(expandHome(claudeHome, home), ".claude", "skills")] : []),
    nodePath.join(
      codexHome ? expandHome(codexHome, home) : nodePath.join(home, ".codex"),
      "skills",
    ),
  ];
  return [...new Set(roots.map((root) => nodePath.resolve(root)))];
}

export class SkillInstallError extends Error {}

function assertSkillId(id: string): void {
  if (!SKILL_ID_PATTERN.test(id)) throw new SkillInstallError(`Not a skill id: ${id}`);
}

/** Skill ids shipped in `<catalog>/<id>/SKILL.md`. */
export async function listCatalogSkills(catalogDir: string | undefined): Promise<string[]> {
  if (!catalogDir) return [];
  const entries = await fs.readdir(catalogDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        SKILL_ID_PATTERN.test(entry.name) &&
        existsSync(nodePath.join(catalogDir, entry.name, "SKILL.md")),
    )
    .map((entry) => entry.name)
    .toSorted();
}

export async function installedSkills(
  ids: ReadonlyArray<string>,
  roots: ReadonlyArray<string>,
): Promise<string[]> {
  const [primary] = roots;
  if (!primary) return [];
  return ids.filter(
    (id) => SKILL_ID_PATTERN.test(id) && existsSync(nodePath.join(primary, id, "SKILL.md")),
  );
}

export async function installSkill(input: {
  readonly id: string;
  readonly catalogDir: string | undefined;
  readonly roots: ReadonlyArray<string>;
}): Promise<string[]> {
  assertSkillId(input.id);
  if (!input.catalogDir) throw new SkillInstallError("This build has no skill catalog.");
  const source = nodePath.join(input.catalogDir, input.id);
  if (!existsSync(nodePath.join(source, "SKILL.md"))) {
    throw new SkillInstallError(`No skill “${input.id}” in this build.`);
  }
  const written: string[] = [];
  for (const root of input.roots) {
    const target = nodePath.join(root, input.id);
    const staging = nodePath.join(root, `.${input.id}.installing-${process.pid}`);
    await fs.mkdir(root, { recursive: true });
    await fs.rm(staging, { recursive: true, force: true });
    await fs.cp(source, staging, { recursive: true, dereference: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
    written.push(target);
  }
  return written;
}

export async function removeSkill(input: {
  readonly id: string;
  readonly roots: ReadonlyArray<string>;
}): Promise<void> {
  assertSkillId(input.id);
  for (const root of input.roots) {
    await fs.rm(nodePath.join(root, input.id), { recursive: true, force: true });
  }
}
