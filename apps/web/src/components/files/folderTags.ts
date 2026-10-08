/**
 * What a folder on this computer is, beyond a folder (flows v2, E5): a project
 * the agents work in, or the code of an app from Home. Files shows it as a
 * small tag so the person can tell "the folder of my site" from any other.
 */

export type FolderTag = "Project" | "App";

function normalize(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

/** `~/projects/notes` → `/home/unowork/projects/notes`. */
export function expandHome(path: string, home: string | null): string | null {
  if (path === "~") return home;
  if (path.startsWith("~/")) return home ? `${normalize(home)}/${path.slice(2)}` : null;
  return path.startsWith("/") ? path : null;
}

/**
 * Tags by absolute folder path. An app's code folder wins over the project of
 * the same folder: "App" says more.
 */
export function folderTags(input: {
  readonly projectFolders: ReadonlyArray<string>;
  readonly appFolders: ReadonlyArray<string | null | undefined>;
  readonly home: string | null;
}): ReadonlyMap<string, FolderTag> {
  const tags = new Map<string, FolderTag>();
  const home = input.home ? normalize(input.home) : null;
  for (const folder of input.projectFolders) {
    const path = expandHome(folder, home);
    // The home folder itself is the default project of every chat: not a "project folder".
    if (path && normalize(path) !== home) tags.set(normalize(path), "Project");
  }
  for (const folder of input.appFolders) {
    const path = folder ? expandHome(folder, home) : null;
    if (path && normalize(path) !== home) tags.set(normalize(path), "App");
  }
  return tags;
}

export function folderTagOf(tags: ReadonlyMap<string, FolderTag>, path: string): FolderTag | null {
  return tags.get(normalize(path)) ?? null;
}
