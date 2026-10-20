/**
 * The skills step's "Found on this computer" and "Add your own skill".
 *
 * Found: the daemon looks in every folder Claude Code, Codex, Uno AI,
 * OpenCode and Hermes read, plus the open project (`skills.scan`, see
 * apps/server/src/skills/skillScan.ts) — what's there already works.
 * Unticking one moves its folders to `<skills folder>-off/` (files kept, no
 * agent reads them); ticking moves them back. Plugin skills go off with
 * their plugin.
 *
 * Add: a link, a dropped SKILL.md / folder / .zip, or (desktop app) the
 * skills folder on the laptop. Everything becomes one .zip that goes to the
 * daemon in chunks; the daemon unpacks it in memory and answers with a
 * preview (`skills.stage`). Only "Add" writes the picked skills, for every
 * project or only this one (`skills.add`). Nothing is run on the way.
 */
import type { EnvironmentId, FoundSkill, SkillAgent, SkillsStageResult } from "@t3tools/contracts";
import { SKILL_IMPORT_MAX_ARCHIVE_BYTES, SKILL_UPLOAD_CHUNK_BYTES } from "@t3tools/contracts";
import JSZip from "jszip";

import { ensureEnvironmentApi } from "../../environmentApi";
import { readFileAsBase64 } from "../../firstProjectFiles";
import type { ProjectUploadFile } from "../../projectUpload";

export const SKILL_AGENT_LABEL: Readonly<Record<SkillAgent, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  uno: "Uno AI",
  opencode: "OpenCode",
  hermes: "Hermes",
};

/** The harness drivers behind each agent (ServerProvider.driver). */
const AGENT_DRIVER: Readonly<Record<SkillAgent, string>> = {
  claude: "claudeAgent",
  codex: "codex",
  uno: "uno",
  opencode: "opencode",
  hermes: "hermes",
};

/** Agents installed on this computer; `null` while the list isn't known yet. */
export function installedAgents(
  providers: ReadonlyArray<{ readonly driver: string; readonly installed: boolean }>,
): ReadonlySet<SkillAgent> | null {
  if (providers.length === 0) return null;
  const drivers = new Set(providers.filter((p) => p.installed).map((p) => String(p.driver)));
  return new Set(
    (Object.keys(AGENT_DRIVER) as SkillAgent[]).filter((agent) => drivers.has(AGENT_DRIVER[agent])),
  );
}

/**
 * "Claude Code · Codex · Uno AI" — only agents this computer has: the
 * OpenCode family is "Uno AI" with our harness and "OpenCode" with a plain one.
 */
export function agentsLine(
  agents: ReadonlyArray<SkillAgent>,
  installed: ReadonlySet<SkillAgent> | null = null,
): string {
  const shown = installed ? agents.filter((agent) => installed.has(agent)) : agents;
  return shown.map((agent) => SKILL_AGENT_LABEL[agent]).join(" · ");
}

/** One row per Claude Code plugin: its skills can only go off together. */
export interface FoundPlugin {
  readonly pluginId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly skills: ReadonlyArray<FoundSkill>;
}

export interface FoundSkillsView {
  readonly project: ReadonlyArray<FoundSkill>;
  readonly computer: ReadonlyArray<FoundSkill>;
  readonly plugins: ReadonlyArray<FoundPlugin>;
  /** Skills the AI uses now (not counting Uno's catalog, counted on its own). */
  readonly activeNames: ReadonlySet<string>;
}

const isOn = (skill: FoundSkill) => skill.enabled !== false && skill.agents.length > 0;

/**
 * Split for the card; Uno's own catalog skills are left out — the lists
 * below already show them as Added.
 */
export function foundSkillsView(
  found: ReadonlyArray<FoundSkill>,
  catalogIds: ReadonlySet<string>,
): FoundSkillsView {
  const own = found.filter((skill) => skill.plugin !== undefined || !catalogIds.has(skill.name));
  const plugins = new Map<string, { name: string; enabled: boolean; skills: FoundSkill[] }>();
  for (const skill of own) {
    if (skill.scope !== "plugin" || !skill.pluginId) continue;
    const entry = plugins.get(skill.pluginId) ?? {
      name: skill.plugin ?? skill.pluginId,
      enabled: skill.enabled !== false,
      skills: [],
    };
    entry.skills.push(skill);
    plugins.set(skill.pluginId, entry);
  }
  // Ones no AI reads yet first: they're the ones with a button.
  const notReadFirst = (a: FoundSkill, b: FoundSkill) =>
    Number(a.agents.length > 0 || a.enabled === false) -
    Number(b.agents.length > 0 || b.enabled === false);
  return {
    project: own.filter((skill) => skill.scope === "project").toSorted(notReadFirst),
    computer: own.filter((skill) => skill.scope === "computer"),
    plugins: [...plugins.entries()].map(([pluginId, entry]) => ({ pluginId, ...entry })),
    activeNames: new Set(
      own
        .filter(isOn)
        .map((skill) => (skill.plugin ? `${skill.plugin}:${skill.name}` : skill.name)),
    ),
  };
}

/** A project's `skills/` folder: no agent reads it, it can only be turned on (copied). */
export function isUnread(skill: FoundSkill): boolean {
  return skill.enabled !== false && skill.agents.length === 0 && skill.offIn.length === 0;
}

/**
 * Where a turned-off skill's files are: "~/.claude/skills-off", or
 * ".claude/skills-off" inside the project.
 */
export function offFolderLine(
  skill: FoundSkill,
  home: string | null,
  projectPath: string | null = null,
): string | null {
  const first = skill.paths[0];
  if (!first) return null;
  const parent = first.replace(/\/+[^/]+\/?$/, "");
  const project = projectPath?.replace(/\/+$/, "");
  if (project && parent.startsWith(`${project}/`)) return parent.slice(project.length + 1);
  const base = home?.replace(/\/+$/, "");
  return base && parent.startsWith(`${base}/`) ? `~${parent.slice(base.length)}` : parent;
}

export async function setFoundSkillEnabled(input: {
  readonly environmentId: EnvironmentId;
  readonly skill: FoundSkill;
  readonly enabled: boolean;
  readonly projectPath: string | null;
}): Promise<void> {
  await ensureEnvironmentApi(input.environmentId).skills.setEnabled({
    paths: [...input.skill.paths],
    enabled: input.enabled,
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
  });
}

export async function setPluginEnabled(input: {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly enabled: boolean;
}): Promise<void> {
  await ensureEnvironmentApi(input.environmentId).skills.setPluginEnabled({
    pluginId: input.pluginId,
    enabled: input.enabled,
  });
}

/** Names a new skill would replace, per place. */
export function existingNames(
  found: ReadonlyArray<FoundSkill>,
  catalogInstalled: ReadonlySet<string>,
) {
  return {
    computer: new Set([
      ...catalogInstalled,
      ...found
        .filter((skill) => skill.scope === "computer" && skill.enabled !== false)
        .map((skill) => skill.name),
    ]),
    project: new Set(
      found
        .filter((skill) => skill.scope === "project" && skill.agents.length > 0)
        .map((skill) => skill.name),
    ),
  };
}

export async function readFoundSkills(
  environmentId: EnvironmentId,
  projectPath: string | null | undefined,
): Promise<ReadonlyArray<FoundSkill>> {
  const result = await ensureEnvironmentApi(environmentId).skills.scan(
    projectPath ? { projectPath } : {},
  );
  return result.skills;
}

// ── Packing what the person dropped ──────────────────────────────────

const JUNK = /(^|\/)(__MACOSX|\.git|node_modules)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$|(^|\/)\._/;

export class SkillPackError extends Error {}

/** "pdf", "my-skills.zip", "SKILL.md". */
export function droppedLabel(files: ReadonlyArray<{ readonly relativePath: string }>): string {
  const first = files[0]?.relativePath ?? "Your files";
  if (files.length === 1) return first.split("/").pop() ?? first;
  const top = first.split("/")[0] ?? first;
  return files.every((file) => file.relativePath.startsWith(`${top}/`))
    ? top
    : `${files.length} files`;
}

/** One .zip of what was dropped (a single .zip goes as it is). */
export async function packDropped(files: ReadonlyArray<ProjectUploadFile>): Promise<Blob> {
  const kept = files.filter((file) => !JUNK.test(file.relativePath));
  if (kept.length === 0) throw new SkillPackError("Nothing to add here.");
  if (kept.length === 1 && /\.zip$/i.test(kept[0]!.relativePath)) {
    const zip = kept[0]!.blob;
    if (zip.size > SKILL_IMPORT_MAX_ARCHIVE_BYTES)
      throw new SkillPackError("The file is bigger than 25 MB.");
    return zip;
  }
  const total = kept.reduce((sum, file) => sum + file.size, 0);
  if (total > SKILL_IMPORT_MAX_ARCHIVE_BYTES * 2) {
    throw new SkillPackError("That's more than 50 MB. A skills folder is usually under 5 MB.");
  }
  const zip = new JSZip();
  for (const file of kept) zip.file(file.relativePath, await file.blob.arrayBuffer());
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
  if (blob.size > SKILL_IMPORT_MAX_ARCHIVE_BYTES)
    throw new SkillPackError("That's more than 25 MB zipped.");
  return blob;
}

function uploadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

/** Sends the zip in chunks and asks for the preview. */
export async function stageDropped(
  environmentId: EnvironmentId,
  files: ReadonlyArray<ProjectUploadFile>,
  label = droppedLabel(files),
): Promise<SkillsStageResult> {
  const api = ensureEnvironmentApi(environmentId);
  const zip = await packDropped(files);
  const id = uploadId();
  for (
    let offset = 0, first = true;
    offset < zip.size || first;
    offset += SKILL_UPLOAD_CHUNK_BYTES
  ) {
    const chunk = await readFileAsBase64(zip.slice(offset, offset + SKILL_UPLOAD_CHUNK_BYTES));
    await api.skills.uploadChunk({ uploadId: id, chunk, first });
    first = false;
  }
  return api.skills.stage({ source: "upload", uploadId: id, name: label });
}

export async function stageLink(
  environmentId: EnvironmentId,
  url: string,
): Promise<SkillsStageResult> {
  return ensureEnvironmentApi(environmentId).skills.stage({ source: "link", url: url.trim() });
}

/** A folder on the Work computer (a project's `skills/`). */
export async function stageFolder(
  environmentId: EnvironmentId,
  path: string,
): Promise<SkillsStageResult> {
  return ensureEnvironmentApi(environmentId).skills.stage({ source: "folder", path });
}

/** The desktop app reads the laptop's skills folder after the person picks it. */
export function canImportFromLaptop(): boolean {
  return (
    typeof window !== "undefined" && typeof window.desktopBridge?.readSkillsFolder === "function"
  );
}

/** `null` when the person cancels the folder dialog. */
export async function stageFromLaptop(
  environmentId: EnvironmentId,
): Promise<SkillsStageResult | null> {
  const picked = await window.desktopBridge?.readSkillsFolder?.();
  if (!picked) return null;
  if (picked.files.length === 0) throw new SkillPackError("This folder is empty.");
  const name = picked.folder.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  const files: ProjectUploadFile[] = picked.files.map((file) => ({
    relativePath: file.path,
    size: file.data.byteLength,
    blob: new Blob([file.data as Uint8Array<ArrayBuffer>]),
  }));
  return stageDropped(environmentId, files, `${name} on this computer`);
}

export type SkillPlace = "computer" | "project";

export async function addStagedSkills(input: {
  readonly environmentId: EnvironmentId;
  readonly token: string;
  readonly keys: ReadonlyArray<string>;
  readonly place: SkillPlace;
  readonly projectPath: string | null;
}): Promise<number> {
  const result = await ensureEnvironmentApi(input.environmentId).skills.add({
    token: input.token,
    keys: [...input.keys],
    scope: input.place,
    ...(input.place === "project" && input.projectPath ? { projectPath: input.projectPath } : {}),
  });
  return result.added.length;
}

// ── Where people's skills are on their laptop ────────────────────────

export interface LaptopSkillsPlace {
  readonly agent: string;
  readonly mac: string;
  readonly windows: string;
}

/** Checked against Claude Code 2.1 and Codex 0.162 (Oct 2026). */
export const LAPTOP_SKILLS_PLACES: ReadonlyArray<LaptopSkillsPlace> = [
  { agent: "Claude Code", mac: "~/.claude/skills", windows: "%USERPROFILE%\\.claude\\skills" },
  {
    agent: "Codex",
    mac: "~/.agents/skills or ~/.codex/skills",
    windows: "%USERPROFILE%\\.agents\\skills",
  },
];

export const MAC_ZIP_COMMAND = "cd ~/.claude && zip -r ~/Desktop/skills.zip skills";
