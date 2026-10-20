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

export type NewProjectSource = "upload" | "folder" | "cloud" | "empty" | "github" | "template";

/**
 * Sources the dialog offers, in order (Misha 11.10: "add a project — from a
 * folder on the computer, from the cloud, from a GitHub link, or upload"):
 * what the person already has comes first — on their laptop, on this
 * computer, in Cloud storage, on GitHub — and an empty folder last. "From a
 * template" stays out until the product has project templates (today there is
 * only the onboarding tutorial).
 */
export const NEW_PROJECT_SOURCES: ReadonlyArray<NewProjectSource> = [
  "upload",
  "folder",
  "cloud",
  "github",
  "empty",
];

export function newProjectSources(): ReadonlyArray<NewProjectSource> {
  return NEW_PROJECT_SOURCES;
}

/**
 * New folders — uploaded, cloned or empty — land in `~/projects/<name>`
 * (like the legacy upload and Move), so a person's folders are in one place.
 */
export const UPLOADED_PROJECTS_FOLDER = "projects";

/** `~/projects` for a home folder. */
export function projectsFolderPath(home: string): string {
  return `${trimSlashes(home)}/${UPLOADED_PROJECTS_FOLDER}`;
}

export function uploadedProjectPath(home: string, name: string): string {
  return `${trimSlashes(home)}/${UPLOADED_PROJECTS_FOLDER}/${name}`;
}

/**
 * The project's name from what was picked: the folder's name, or the zip's
 * without `.zip`. Falls back to "my-project".
 */
export function uploadProjectName(
  picked: ReadonlyArray<{ readonly relativePath: string }>,
): string {
  const first = picked[0]?.relativePath ?? "";
  const raw = first.includes("/")
    ? first.split("/")[0]!
    : picked.length === 1 && /\.zip$/i.test(first)
      ? first.replace(/\.zip$/i, "")
      : "";
  return normalizeProjectName(raw) || "my-project";
}

/** A name not taken in `~/projects`: `site`, then `site-2`, `site-3`… */
export function freeProjectName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${name}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name}-${Date.now()}`;
}

/**
 * A project copied from Cloud storage is named after the folder picked there,
 * or after the bucket when the whole bucket is taken.
 */
export function cloudProjectName(bucketName: string, prefix: string): string {
  const segments = prefix.split("/").filter(Boolean);
  return normalizeProjectName(segments.at(-1) ?? bucketName) || "my-project";
}

/** Where the person is in Cloud storage: the bucket, then each folder down to `prefix`. */
export function cloudCrumbs(
  bucketName: string,
  prefix: string,
): ReadonlyArray<{ readonly label: string; readonly prefix: string }> {
  const crumbs = [{ label: bucketName, prefix: "" }];
  let walked = "";
  for (const segment of prefix.split("/").filter(Boolean)) {
    walked += `${segment}/`;
    crumbs.push({ label: segment, prefix: walked });
  }
  return crumbs;
}

/** The daemon copies at most this many picked items in one go. */
export const CLOUD_COPY_MAX_ITEMS = 1000;

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

/** A new folder's name: letters, digits, dot, dash, underscore; not taken in `~/projects`. */
export function checkNewFolderName(raw: string, taken: ReadonlySet<string>): NameCheck {
  if (raw.trim().length === 0) return { ok: false, error: "Type a name." };
  const name = normalizeProjectName(raw);
  if (name.length === 0 || name === "." || name === "..") {
    return { ok: false, error: "Use letters, numbers, dashes or dots." };
  }
  if (taken.has(name)) {
    return {
      ok: false,
      error: `There is already a folder “${name}” in ~/projects. Pick another name.`,
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
  // Copied without its scheme ("github.com/owner/repo"): still the same address.
  const typed = /^(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\//i.test(value)
    ? `https://${value.replace(/^www\./i, "")}`
    : value;
  let remoteUrl = expandGitRemoteUrl(typed);
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
      error: `There is already a folder “${name}” in ~/projects.`,
    };
  }
  return { ok: true, remoteUrl, name };
}

/** What a new project's folder starts with. */
export type NewProjectContents = "files" | "repository" | "none";

/**
 * The first message of a project the person told Uno about (Misha 11.10:
 * "just tell about it and add files — not only a folder; describe the context
 * yourself when there is no folder"). Their words go first, as they wrote them.
 */
export function describedProjectPrompt(input: {
  readonly name: string;
  readonly folder: string;
  readonly about: string;
  readonly contents: NewProjectContents;
}): string {
  const about = input.about.trim();
  if (input.contents === "none") {
    return [
      `I'm starting a new project "${input.name}" in ${input.folder}; the folder is empty for now.`,
      `What I have in mind: ${about}`,
      "Ask me what you need to know, one question at a time, then suggest where to start.",
    ].join("\n\n");
  }
  return [
    input.contents === "repository"
      ? `I've cloned my project "${input.name}" into ${input.folder}.`
      : `I've added my project "${input.name}" to ${input.folder}.`,
    `About it, in my words: ${about}`,
    "Look at what's inside, tell me in two or three plain sentences how you understand it, and suggest the next step.",
  ].join("\n\n");
}

/**
 * A clone that failed because this computer can't sign in to the host: a
 * private repository (or a typo — GitHub answers the same for both). git's
 * own words ("could not read Username for 'https://github.com'") are not for
 * people (icp3 09.10: Misha's private repo on a fresh cloud computer).
 */
export function isRepoAccessError(message: string): boolean {
  return /could not read (Username|Password)|Authentication failed|Repository not found|terminal prompts disabled|Permission denied \(publickey\)|returned error: 40[134]|Invalid username or password/i.test(
    message,
  );
}

/**
 * What a person reads when a clone failed for another reason than access.
 * git's own text (and the "Source control repository operation … failed"
 * wrapper around it) never reaches the screen (Misha 20.10).
 */
export function cloneFailureMessage(message: string): string {
  if (/already exists and is not (empty|a directory)/i.test(message)) {
    return "There is already a folder with this name in ~/projects. Remove it or pick another repository.";
  }
  if (
    /Could not resolve host|unable to access|Failed to connect|Connection (refused|reset|timed out)|Network is unreachable|early EOF|unexpected disconnect/i.test(
      message,
    )
  ) {
    return "Couldn't reach the repository. Check the internet connection and try again.";
  }
  if (/timed out|timeout/i.test(message)) {
    return "Cloning took too long. Try again — a very large repository is easier to clone from a chat: ask Uno to do it.";
  }
  if (/No space left on device|Disk quota exceeded/i.test(message)) {
    return "There is no free space on this computer for the repository.";
  }
  if (
    /does not appear to be a git repository|not found|not a valid repository name/i.test(message)
  ) {
    return "There is no repository at this address. Check it and try again.";
  }
  return "Couldn't clone the repository. Check the address and try again.";
}

/** `owner/repo` of a GitHub remote, or null. */
export function githubRepoSlug(remoteUrl: string): string | null {
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * `https://github.com/owner/repo.git` of a GitHub remote however it was typed
 * (`git@github.com:…` included): the account's GitHub signs git in over https.
 * Other hosts come back unchanged.
 */
export function githubHttpsRemote(remoteUrl: string): string {
  const slug = githubRepoSlug(remoteUrl);
  return slug ? `https://github.com/${slug}.git` : remoteUrl;
}

/** What the account's GitHub looks like from this computer (`GET /api/manager/github`). */
export interface RepoAccessGithubState {
  readonly available: boolean;
  readonly connected: boolean;
  readonly accounts: ReadonlyArray<string>;
}

/**
 * What to offer when a clone was refused:
 * - `connect`  — GitHub isn't connected to the account yet: one button, once,
 *   and it works on every computer;
 * - `add-repo` — it is connected, but Uno wasn't given this repository;
 * - `ssh-key`  — the account's GitHub can't be used here (not a cloud
 *   computer, an older console, another host): the key Uno makes for this
 *   computer (connectGithubPrompt).
 */
export type RepoAccessOffer = "connect" | "add-repo" | "ssh-key";

export function repoAccessOffer(
  remoteUrl: string,
  github: RepoAccessGithubState | null,
): RepoAccessOffer {
  if (github === null || !github.available || githubRepoSlug(remoteUrl) === null) return "ssh-key";
  return github.connected ? "add-repo" : "connect";
}

/**
 * The task for Uno when the repository is private: connect this computer to
 * GitHub with an SSH key (one paste on github.com, no tokens to pick scopes
 * for) and clone into the project folder made for it.
 */
export function connectGithubPrompt(remoteUrl: string): string {
  const slug = githubRepoSlug(remoteUrl);
  const repo = slug ?? remoteUrl;
  const sshUrl = slug ? `git@github.com:${slug}.git` : remoteUrl;
  return [
    `This folder is for ${repo} — a private repository. This computer isn't signed in to GitHub yet.`,
    "Connect it with an SSH key, no tokens: make a key if there is none (ssh-keygen -t ed25519), show me the public key and the page to add it — https://github.com/settings/ssh/new — and wait until I say it's added.",
    `Then check with ssh -T git@github.com and clone ${sshUrl} into this folder (it is empty).`,
  ].join("\n\n");
}
