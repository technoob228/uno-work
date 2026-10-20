/**
 * "Add your own skill": from a link (GitHub repo or folder, a skills.sh page,
 * a .zip, a SKILL.md), from an uploaded .zip, or from a folder on this
 * computer. Two steps, so the person sees what they get before anything is
 * written:
 *
 * 1. `stageSkills` reads the source into memory and finds every folder with
 *    a SKILL.md that has a description — the preview (name, description,
 *    where it sits, how many files and scripts). Nothing touches the agents'
 *    folders and nothing is run.
 * 2. `addStagedSkills` copies the picked ones into the agents' folders: for
 *    every project (`~/.claude/skills` + Codex's) or only one
 *    (`<project>/.claude/skills` + `<project>/.agents/skills`).
 *
 * A skill from the internet is someone else's instructions and maybe
 * scripts, so: sizes are capped before and after unpacking (zip bombs);
 * archive paths with `..`, a drive or a leading `/` reject the whole archive
 * (zip slip); only regular files are written, never symlinks, never with the
 * executable bit; links must be https and must not point into this
 * computer's own network (every redirect is checked again).
 */
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import {
  SKILL_IMPORT_MAX_ARCHIVE_BYTES,
  SKILL_UPLOAD_ID_PATTERN,
  type SkillsStageResult,
  type StagedSkill,
} from "@t3tools/contracts";

import { readZip, ZipFormatError } from "../files/zipPackage.ts";
import { isScriptPath, parseSkillManifest, skillFolderName } from "./skillManifest.ts";

export class SkillImportError extends Error {
  override readonly name = "SkillImportError";
}

/** Unpacked bytes one import may hold. */
export const SKILL_IMPORT_MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
export const SKILL_IMPORT_MAX_ENTRIES = 20_000;
export const SKILL_IMPORT_MAX_SKILLS = 200;
export const SKILL_MAX_FILES = 2_000;
export const SKILL_MAX_BYTES = 30 * 1024 * 1024;
const STAGE_TTL_MS = 30 * 60 * 1000;
const MAX_STAGES = 6;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

export interface ArchiveFile {
  /** posix, relative, already checked. */
  readonly path: string;
  readonly data: Uint8Array;
}

interface StagedSkillData extends StagedSkill {
  readonly entries: ReadonlyArray<ArchiveFile>;
}

interface Stage {
  readonly token: string;
  readonly createdAt: number;
  readonly skills: ReadonlyArray<StagedSkillData>;
}

const stages = new Map<string, Stage>();

function pruneStages(now: number): void {
  for (const [token, stage] of stages) {
    if (now - stage.createdAt > STAGE_TTL_MS) stages.delete(token);
  }
  while (stages.size >= MAX_STAGES) {
    const oldest = stages.keys().next().value;
    if (oldest === undefined) break;
    stages.delete(oldest);
  }
}

// ── Paths ────────────────────────────────────────────────────────────

const JUNK_SEGMENTS = new Set(["__MACOSX", ".git", "node_modules", ".DS_Store", "Thumbs.db"]);

/**
 * A safe relative posix path, `null` for junk (macOS metadata, .git,
 * node_modules). Throws on anything that could leave the folder.
 */
export function safeArchivePath(raw: string): string | null {
  const name = raw.replace(/\\/g, "/");
  if (name.includes("\0")) throw new SkillImportError("This archive has a broken file name.");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new SkillImportError("This archive has files with absolute paths. It wasn't opened.");
  }
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new SkillImportError("This archive has files that point outside it. It wasn't opened.");
  }
  if (parts.length === 0) return null;
  if (parts.some((part) => JUNK_SEGMENTS.has(part) || part.startsWith("._"))) return null;
  return parts.join("/");
}

function under(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

function relativeTo(path: string, dir: string): string {
  return dir === "" ? path : path.slice(dir.length + 1);
}

// ── Finding skills in a set of files ─────────────────────────────────

/** Files of one source → the skills in it, and the SKILL.md files that aren't usable. */
export function findSkills(
  files: ReadonlyArray<ArchiveFile>,
  options?: {
    /** Only this subfolder (a GitHub `tree/` link). */
    readonly subPath?: string;
    /** Only the skill with this name or folder (a skills.sh link). */
    readonly only?: string;
  },
): { skills: StagedSkillData[]; skipped: Array<{ location: string; reason: string }> } {
  const sub = options?.subPath?.replace(/^\/+|\/+$/g, "") ?? "";
  // Codex's built-in skills ride along when someone zips ~/.codex/skills.
  const scoped = files.filter(
    (file) => under(file.path, sub) && !file.path.split("/").includes(".system"),
  );
  const skillDirs = scoped
    .filter((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))
    .map((file) => (file.path === "SKILL.md" ? "" : file.path.slice(0, -"/SKILL.md".length)))
    .toSorted((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const skills: StagedSkillData[] = [];
  const skipped: Array<{ location: string; reason: string }> = [];
  const names = new Set<string>();
  for (const dir of skillDirs) {
    const location = dir || "top folder";
    const nested = skillDirs.filter((other) => other !== dir && under(other, dir) && other !== "");
    const own = scoped.filter(
      (file) => under(file.path, dir) && !nested.some((inner) => under(file.path, inner)),
    );
    const manifestFile = own.find((file) => relativeTo(file.path, dir) === "SKILL.md");
    const manifest = manifestFile
      ? parseSkillManifest(new TextDecoder().decode(manifestFile.data))
      : null;
    if (!manifest) {
      skipped.push({ location, reason: "SKILL.md doesn't start with a name and a description." });
      continue;
    }
    if (!manifest.description) {
      skipped.push({ location, reason: "SKILL.md has no description." });
      continue;
    }
    const fallback = dir.split("/").pop() ?? "";
    const folder = skillFolderName(manifest.name ?? fallback);
    if (!folder) {
      skipped.push({ location, reason: "SKILL.md has no usable name." });
      continue;
    }
    if (options?.only) {
      const wanted = skillFolderName(options.only);
      if (folder !== wanted && skillFolderName(fallback) !== wanted) continue;
    }
    if (names.has(folder)) {
      skipped.push({ location, reason: `Another skill here is also called “${folder}”.` });
      continue;
    }
    const bytes = own.reduce((sum, file) => sum + file.data.length, 0);
    if (own.length > SKILL_MAX_FILES || bytes > SKILL_MAX_BYTES) {
      skipped.push({ location, reason: "Too big for a skill (over 2,000 files or 30 MB)." });
      continue;
    }
    if (skills.length >= SKILL_IMPORT_MAX_SKILLS) {
      skipped.push({ location, reason: "More than 200 skills in one go." });
      continue;
    }
    names.add(folder);
    skills.push({
      key: String(skills.length),
      name: folder,
      description: manifest.description,
      location: dir,
      files: own.length,
      bytes,
      scripts: own.filter((file) => isScriptPath(file.path)).length,
      entries: own.map((file) => ({ path: relativeTo(file.path, dir), data: file.data })),
    });
  }
  return { skills, skipped };
}

// ── Sources ──────────────────────────────────────────────────────────

/** A zip, as files. GitHub archives wrap everything in `<repo>-<ref>/`: `stripTop` drops it. */
export function filesFromZip(
  bytes: Uint8Array,
  options?: { readonly stripTop?: boolean },
): ArchiveFile[] {
  if (bytes.length > SKILL_IMPORT_MAX_ARCHIVE_BYTES) {
    throw new SkillImportError("The archive is bigger than 25 MB.");
  }
  try {
    // First pass: names only, nothing inflated — keep files of folders with a SKILL.md.
    const names: string[] = [];
    readZip(bytes, {
      maxEntries: SKILL_IMPORT_MAX_ENTRIES,
      include: (name) => {
        names.push(name);
        return false;
      },
    });
    const strip = (name: string) => {
      const safe = safeArchivePath(name);
      if (safe === null || !options?.stripTop) return safe;
      const slash = safe.indexOf("/");
      return slash < 0 ? null : safe.slice(slash + 1);
    };
    const paths = new Map<string, string>();
    for (const name of names) {
      const path = strip(name);
      if (path) paths.set(name, path);
    }
    const dirs = [...paths.values()]
      .filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
      .map((path) => (path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length)));
    const wanted = (name: string) => {
      const path = paths.get(name);
      return path !== undefined && dirs.some((dir) => under(path, dir));
    };
    return readZip(bytes, {
      maxEntries: SKILL_IMPORT_MAX_ENTRIES,
      maxTotalBytes: SKILL_IMPORT_MAX_UNPACKED_BYTES,
      include: wanted,
    }).map((entry) => ({ path: paths.get(entry.name)!, data: entry.data }));
  } catch (cause) {
    if (cause instanceof SkillImportError) throw cause;
    if (cause instanceof ZipFormatError) {
      throw new SkillImportError(
        cause.message.includes("too large")
          ? "The archive unpacks to more than 100 MB."
          : `This isn't a zip we can open (${cause.message}).`,
      );
    }
    throw cause;
  }
}

/** A folder on this computer, read whole; symlinks inside aren't followed. */
export async function filesFromFolder(folder: string): Promise<ArchiveFile[]> {
  if (!nodePath.isAbsolute(folder)) throw new SkillImportError("Not a folder on this computer.");
  const root = await fs.realpath(folder).catch(() => null);
  if (!root || !(await fs.stat(root)).isDirectory()) {
    throw new SkillImportError("This folder isn't there.");
  }
  const out: ArchiveFile[] = [];
  let total = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (safeArchivePath(path) === null) continue;
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, path);
      else if (entry.isFile()) {
        if (out.length >= SKILL_IMPORT_MAX_ENTRIES)
          throw new SkillImportError("Too many files in this folder.");
        const data = new Uint8Array(await fs.readFile(full));
        total += data.length;
        if (total > SKILL_IMPORT_MAX_UNPACKED_BYTES) {
          throw new SkillImportError("This folder holds more than 100 MB.");
        }
        out.push({ path, data });
      }
    }
  };
  await walk(root, "");
  return out;
}

export type SkillLink =
  | {
      readonly kind: "zip";
      readonly url: string;
      readonly stripTop: boolean;
      readonly subPath?: string;
      readonly only?: string;
      readonly label: string;
    }
  | {
      readonly kind: "file";
      readonly url: string;
      readonly label: string;
      readonly fallbackName: string;
    };

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;

function githubZip(owner: string, repo: string, ref: string): string {
  return `https://codeload.github.com/${owner}/${repo}/zip/${encodeURIComponent(ref)}`;
}

/** What a pasted link means. Throws a person-readable error for anything else. */
export function resolveSkillLink(input: string): SkillLink {
  let url: URL;
  const trimmed = input.trim();
  try {
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new SkillImportError("That doesn't look like a link.");
  }
  if (url.protocol !== "https:") throw new SkillImportError("Use an https:// link.");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (host === "skills.sh") {
    if (parts[0] === "site" || parts.length < 2) {
      throw new SkillImportError(
        "This skill isn't on GitHub, so we can't fetch it. Download it as a .zip and drop it here.",
      );
    }
    const [owner, repo, skill] = parts as [string, string, string | undefined];
    if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
      throw new SkillImportError("That skills.sh link doesn't point to a skill.");
    }
    return {
      kind: "zip",
      url: githubZip(owner, repo, "HEAD"),
      stripTop: true,
      ...(skill ? { only: skill } : {}),
      label: `skills.sh · ${owner}/${repo}${skill ? ` · ${skill}` : ""}`,
    };
  }
  if (host === "github.com") {
    const [owner, rawRepo, kind, ref, ...rest] = parts;
    const repo = rawRepo?.replace(/\.git$/, "");
    if (!owner || !repo || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo)) {
      throw new SkillImportError("Paste a link to a GitHub repository or a folder in it.");
    }
    if (!kind) {
      return {
        kind: "zip",
        url: githubZip(owner, repo, "HEAD"),
        stripTop: true,
        label: `github.com/${owner}/${repo}`,
      };
    }
    if ((kind === "tree" || kind === "blob") && ref) {
      let sub = rest.join("/");
      if (kind === "blob") sub = sub.split("/").slice(0, -1).join("/");
      return {
        kind: "zip",
        url: githubZip(owner, repo, ref),
        stripTop: true,
        ...(sub ? { subPath: sub } : {}),
        label: `github.com/${owner}/${repo}${sub ? ` · ${sub}` : ""}`,
      };
    }
    throw new SkillImportError("Paste a link to a GitHub repository or a folder in it.");
  }
  if (host === "raw.githubusercontent.com") {
    const [owner, repo, ref, ...rest] = parts;
    if (
      owner &&
      repo &&
      ref &&
      rest.length > 0 &&
      GITHUB_NAME.test(owner) &&
      GITHUB_NAME.test(repo)
    ) {
      const sub = rest.slice(0, -1).join("/");
      return {
        kind: "zip",
        url: githubZip(owner, repo, ref),
        stripTop: true,
        ...(sub ? { subPath: sub } : {}),
        label: `github.com/${owner}/${repo}${sub ? ` · ${sub}` : ""}`,
      };
    }
  }
  const last = parts[parts.length - 1] ?? "";
  if (/\.zip$/i.test(last)) {
    return { kind: "zip", url: url.toString(), stripTop: false, label: `${host} · ${last}` };
  }
  if (/^skill\.md$/i.test(last)) {
    return {
      kind: "file",
      url: url.toString(),
      label: `${host} · ${parts.join("/")}`,
      fallbackName: parts[parts.length - 2] ?? "skill",
    };
  }
  throw new SkillImportError(
    "This link isn't a skill. Paste a GitHub folder, a skills.sh page, a .zip or a SKILL.md link.",
  );
}

/** Loopback, private, link-local, CGNAT, multicast, the unspecified address. */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff")
  );
}

/** The bit of `fetch` used here (tests pass their own). */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

export type HostLookup = (host: string) => Promise<ReadonlyArray<string>>;

const defaultLookup: HostLookup = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

async function assertPublicUrl(url: URL, resolve: HostLookup): Promise<void> {
  if (url.protocol !== "https:")
    throw new SkillImportError("The link moved to a non-https address.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new SkillImportError("Links to this computer's own network aren't allowed.");
  }
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) throw new SkillImportError(`Couldn't find ${host}.`);
  if (addresses.some(isPrivateAddress)) {
    throw new SkillImportError("Links to this computer's own network aren't allowed.");
  }
}

/** GET with redirects checked one by one, a size cap and a timeout. */
export async function fetchCapped(
  rawUrl: string,
  options?: {
    readonly maxBytes?: number;
    readonly fetchImpl?: FetchLike;
    readonly resolve?: HostLookup;
  },
): Promise<Uint8Array> {
  const maxBytes = options?.maxBytes ?? SKILL_IMPORT_MAX_ARCHIVE_BYTES;
  const doFetch = options?.fetchImpl ?? fetch;
  const resolve = options?.resolve ?? defaultLookup;
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(url, resolve);
    const response = await doFetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "UnoWork-skills/1", accept: "*/*" },
    }).catch((cause: unknown) => {
      throw new SkillImportError(
        cause instanceof Error && cause.name === "TimeoutError"
          ? "The download took too long."
          : `Couldn't download from ${url.hostname}.`,
      );
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new SkillImportError("The link redirects nowhere.");
      url = new URL(location, url);
      continue;
    }
    if (response.status === 404) {
      throw new SkillImportError(
        "Nothing at this link. If the repository is private, download it as a .zip and drop it here.",
      );
    }
    if (!response.ok) throw new SkillImportError(`The download failed (HTTP ${response.status}).`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new SkillImportError("The download is bigger than 25 MB.");
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SkillImportError("The download is bigger than 25 MB.");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
  throw new SkillImportError("The link redirects too many times.");
}

// ── Uploads (chunks of a .zip from the browser) ──────────────────────

export function uploadsDir(): string {
  return nodePath.join(tmpdir(), "uno-skill-uploads");
}

function uploadPath(uploadId: string): string {
  if (!SKILL_UPLOAD_ID_PATTERN.test(uploadId)) throw new SkillImportError("Bad upload.");
  return nodePath.join(uploadsDir(), `${uploadId}.zip`);
}

export async function appendUploadChunk(input: {
  readonly uploadId: string;
  readonly chunk: string;
  readonly first: boolean;
}): Promise<number> {
  const path = uploadPath(input.uploadId);
  await fs.mkdir(uploadsDir(), { recursive: true, mode: 0o700 });
  const data = Buffer.from(input.chunk, "base64");
  if (input.first) {
    // Old uploads nobody finished.
    const now = Date.now();
    for (const name of await fs.readdir(uploadsDir()).catch(() => [])) {
      const file = nodePath.join(uploadsDir(), name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > STAGE_TTL_MS) await fs.rm(file, { force: true });
    }
    await fs.writeFile(path, data, { mode: 0o600 });
  } else {
    if (!existsSync(path)) throw new SkillImportError("The upload was interrupted. Try again.");
    await fs.appendFile(path, data);
  }
  const { size } = await fs.stat(path);
  if (size > SKILL_IMPORT_MAX_ARCHIVE_BYTES) {
    await fs.rm(path, { force: true });
    throw new SkillImportError("The file is bigger than 25 MB.");
  }
  return size;
}

async function takeUpload(uploadId: string): Promise<Uint8Array> {
  const path = uploadPath(uploadId);
  try {
    return new Uint8Array(await fs.readFile(path));
  } catch {
    throw new SkillImportError("The upload was interrupted. Try again.");
  } finally {
    await fs.rm(path, { force: true });
  }
}

// ── Stage → add ──────────────────────────────────────────────────────

export type StageSource =
  | { readonly source: "link"; readonly url: string }
  | { readonly source: "upload"; readonly uploadId: string; readonly name: string }
  | { readonly source: "folder"; readonly path: string };

const NO_SKILLS =
  "No skills here. A skill is a folder with a SKILL.md that starts with a name and a description.";

export async function stageSkills(
  input: StageSource,
  deps?: {
    readonly fetchImpl?: FetchLike;
    readonly resolve?: HostLookup;
    readonly now?: number;
  },
): Promise<SkillsStageResult> {
  let files: ArchiveFile[];
  let sourceLabel: string;
  let sourceUrl: string | undefined;
  let options: { subPath?: string; only?: string } = {};
  if (input.source === "link") {
    const link = resolveSkillLink(input.url);
    sourceLabel = link.label;
    sourceUrl = input.url.trim();
    const bytes = await fetchCapped(link.url, deps);
    if (link.kind === "file") {
      const manifest = parseSkillManifest(new TextDecoder().decode(bytes));
      files = [
        {
          path: `${skillFolderName(manifest?.name ?? link.fallbackName) ?? "skill"}/SKILL.md`,
          data: bytes,
        },
      ];
    } else {
      files = filesFromZip(bytes, { stripTop: link.stripTop });
      options = {
        ...(link.subPath ? { subPath: link.subPath } : {}),
        ...(link.only ? { only: link.only } : {}),
      };
    }
  } else if (input.source === "upload") {
    sourceLabel = input.name || "Your file";
    files = filesFromZip(await takeUpload(input.uploadId));
  } else {
    sourceLabel = input.path;
    files = await filesFromFolder(input.path);
  }
  const { skills, skipped } = findSkills(files, options);
  if (skills.length === 0) {
    const first = skipped[0];
    throw new SkillImportError(
      options.only
        ? `No skill called “${options.only}” in this repository.`
        : first
          ? `${NO_SKILLS} ${first.location}: ${first.reason}`
          : NO_SKILLS,
    );
  }
  const now = deps?.now ?? Date.now();
  pruneStages(now);
  const token = randomBytes(16).toString("hex");
  stages.set(token, { token, createdAt: now, skills });
  return {
    token,
    sourceLabel,
    ...(sourceUrl ? { sourceUrl } : {}),
    skills: skills.map(({ entries: _entries, ...skill }) => skill),
    skipped,
  };
}

/** Where a project's own skills go: Claude Code + OpenCode, and Codex + OpenCode. */
export function projectTargetRoots(projectPath: string): string[] {
  return [
    nodePath.join(projectPath, ".claude", "skills"),
    nodePath.join(projectPath, ".agents", "skills"),
  ];
}

async function writeSkillFolder(root: string, skill: StagedSkillData): Promise<string> {
  const target = nodePath.join(root, skill.name);
  const staging = nodePath.join(
    root,
    `.${skill.name}.adding-${process.pid}-${randomBytes(3).toString("hex")}`,
  );
  await fs.mkdir(root, { recursive: true });
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { mode: 0o755 });
  try {
    for (const entry of skill.entries) {
      const destination = nodePath.resolve(staging, entry.path);
      if (!destination.startsWith(`${staging}${nodePath.sep}`)) {
        throw new SkillImportError("A file in this skill points outside its folder.");
      }
      await fs.mkdir(nodePath.dirname(destination), { recursive: true, mode: 0o755 });
      // `wx`: a fresh regular file, never through an existing link.
      await fs.writeFile(destination, entry.data, { flag: "wx", mode: 0o644 });
    }
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(staging, target);
  } catch (cause) {
    await fs.rm(staging, { recursive: true, force: true });
    throw cause;
  }
  return target;
}

export async function addStagedSkills(input: {
  readonly token: string;
  readonly keys: ReadonlyArray<string>;
  readonly roots: ReadonlyArray<string>;
}): Promise<Array<{ name: string; paths: string[] }>> {
  const stage = stages.get(input.token);
  if (!stage || Date.now() - stage.createdAt > STAGE_TTL_MS) {
    stages.delete(input.token);
    throw new SkillImportError("This preview expired. Add the skill again.");
  }
  if (input.roots.length === 0) throw new SkillImportError("Nowhere to add the skill.");
  const picked = stage.skills.filter((skill) => input.keys.includes(skill.key));
  if (picked.length === 0) throw new SkillImportError("Pick at least one skill.");
  const added: Array<{ name: string; paths: string[] }> = [];
  for (const skill of picked) {
    const paths: string[] = [];
    for (const root of input.roots) paths.push(await writeSkillFolder(root, skill));
    added.push({ name: skill.name, paths });
  }
  return added;
}

/** Tests only. */
export function clearStagesForTest(): void {
  stages.clear();
}
