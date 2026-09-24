/**
 * The pure parts of "New project" (sidebar New ▾): the four sources, the
 * folder picker fenced to the home folder, names and GitHub addresses. No I/O
 * here — the dialog feeds these what the daemon answered.
 */
import {
  expandGitRemoteUrl,
  inferProjectNameFromGitUrl,
  normalizeProjectName,
} from "../../firstProject";

export type NewProjectSource = "folder" | "empty" | "github" | "template";

/**
 * Sources the dialog offers. "From a template" stays out until the product
 * has project templates (today there is only the onboarding tutorial).
 */
export const NEW_PROJECT_SOURCES: ReadonlyArray<NewProjectSource> = ["folder", "empty", "github"];

function trimSlashes(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** `path` is the home folder or inside it. */
export function isInsideHome(path: string, home: string): boolean {
  const p = trimSlashes(path);
  const h = trimSlashes(home);
  return p === h || p.startsWith(`${h}/`);
}

/** The picker never leaves the home folder: anything outside reads as home. */
export function clampToHome(path: string | null, home: string): string {
  return path !== null && isInsideHome(path, home) ? trimSlashes(path) : trimSlashes(home);
}

/** System folders a person never makes a project of (macOS / Linux home roots). */
const SYSTEM_HOME_FOLDERS = new Set(["Library", "Applications", "snap"]);

/** Folders the picker lists: no dot-folders, no system folders at the home root. */
export function isPickableFolder(name: string, parentPath: string, home: string): boolean {
  if (name.startsWith(".")) return false;
  return !(trimSlashes(parentPath) === trimSlashes(home) && SYSTEM_HOME_FOLDERS.has(name));
}

export interface Crumb {
  readonly label: string;
  readonly path: string;
}

/** "Home folder › projects › site" for a path inside the home folder. */
export function homeCrumbs(path: string, home: string): ReadonlyArray<Crumb> {
  const h = trimSlashes(home);
  const inside = clampToHome(path, h);
  const crumbs: Crumb[] = [{ label: "Home folder", path: h }];
  const rest = inside.slice(h.length).split("/").filter(Boolean);
  let current = h;
  for (const segment of rest) {
    current = `${current}/${segment}`;
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

/** `~/projects/site` for display. */
export function tildePath(path: string, home: string): string {
  const h = trimSlashes(home);
  const p = trimSlashes(path);
  if (p === h) return "~";
  return isInsideHome(p, h) ? `~${p.slice(h.length)}` : p;
}

export interface RecentFolderInput {
  readonly id: string;
  readonly cwd: string;
  readonly name: string;
  readonly updatedAt?: string | undefined;
}

/**
 * Folders already used for chats, newest first: the likely picks, shown above
 * the listing. Only folders inside the home folder (and not the home folder
 * itself — that is plain "New chat").
 */
export function recentHomeFolders<T extends RecentFolderInput>(
  projects: ReadonlyArray<T>,
  home: string,
  limit = 5,
): T[] {
  const h = trimSlashes(home);
  const seen = new Set<string>();
  return projects
    .filter((project) => {
      const cwd = trimSlashes(project.cwd);
      if (cwd === h || !isInsideHome(cwd, h) || seen.has(cwd)) return false;
      seen.add(cwd);
      return true;
    })
    .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, limit);
}

export type NameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly error: string };

/** A new folder's name: letters, digits, dot, dash, underscore; not taken. */
export function checkNewFolderName(raw: string, taken: ReadonlySet<string>): NameCheck {
  if (raw.trim().length === 0) return { ok: false, error: "Give the project a name." };
  const name = normalizeProjectName(raw);
  if (name.length === 0 || name === "." || name === "..") {
    return { ok: false, error: "Use letters, numbers, dashes or dots." };
  }
  if (taken.has(name)) {
    return {
      ok: false,
      error: `There is already a folder “${name}” in your home folder — open it with “A folder on this computer”.`,
    };
  }
  return { ok: true, name };
}

export type RepoCheck =
  | { readonly ok: true; readonly remoteUrl: string; readonly name: string }
  | { readonly ok: false; readonly error: string };

/**
 * A repository address as people paste it: `owner/repo`, an https URL (with
 * or without `.git`, with a trailing `/tree/main`…), or `git@github.com:…`.
 */
export function checkRepositoryInput(raw: string, taken: ReadonlySet<string>): RepoCheck {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: "Paste the repository address." };
  let remoteUrl = expandGitRemoteUrl(value);
  const web = /^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([\w.-]+)\/([\w.-]+)/i.exec(
    remoteUrl,
  );
  if (web) {
    const repo = web[3]!.replace(/\.git$/i, "");
    remoteUrl = `https://${web[1]!.toLowerCase()}/${web[2]}/${repo}.git`;
  } else if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(remoteUrl)) {
    return { ok: false, error: "That doesn't look like a repository address." };
  }
  const name = inferProjectNameFromGitUrl(remoteUrl);
  if (taken.has(name)) {
    return {
      ok: false,
      error: `There is already a folder “${name}” in your home folder.`,
    };
  }
  return { ok: true, remoteUrl, name };
}
