/**
 * Which of the person's team projects (the Uno cloud's, by number) live on
 * this computer, in which folder; and the key values this computer knows for
 * a folder, so nothing that leaves here carries them (scrub.logic.ts).
 *
 * A project is here when Uno Work's project sync knows it: one someone else
 * owns carries the team's project number (`team.id`); the person's own
 * carries its name, which is the team project's name. Its folder is the
 * Uno Work project's folder.
 *
 * @module team/teamProjects
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import { envValues } from "./scrub.logic.ts";
import type { TeamProject } from "./teamCloud.logic.ts";

export interface LocalProjectRef {
  /** Uno Work's project id here. */
  readonly projectId: string;
  readonly name: string | null;
  /** Set for a project someone else owns: the team project's number. */
  readonly teamId: number | null;
  readonly folder: string | null;
}

export interface TeamProjectHere {
  readonly teamProjectId: number;
  readonly name: string;
  readonly role: "owner" | "editor";
  readonly localProjectId: string;
  readonly folder: string;
}

/** The team projects that live here, each with its folder (pure). */
export function projectsHere(
  team: ReadonlyArray<TeamProject>,
  local: ReadonlyArray<LocalProjectRef>,
): ReadonlyArray<TeamProjectHere> {
  return team.flatMap((project) => {
    const byId = local.find((entry) => entry.teamId === project.id && entry.folder !== null);
    const byName =
      project.role === "owner"
        ? local.find(
            (entry) =>
              entry.teamId === null && entry.name === project.name && entry.folder !== null,
          )
        : undefined;
    const here = byId ?? byName;
    return here === undefined
      ? []
      : [
          {
            teamProjectId: project.id,
            name: project.name,
            role: project.role,
            localProjectId: here.projectId,
            folder: here.folder!,
          },
        ];
  });
}

const ENV_FILES = [".env", ".env.local", ".env.development", ".env.production", ".env.secrets"];

/** The key values a folder's `.env` files hold, cached by their change time. */
export function makeFolderSecrets() {
  const cache = new Map<
    string,
    { readonly stamp: string; readonly values: ReadonlyArray<string> }
  >();
  return async (folder: string): Promise<ReadonlyArray<string>> => {
    const files = ENV_FILES.map((name) => path.join(folder, name));
    const stats = await Promise.all(files.map((file) => fsp.stat(file).catch(() => null)));
    const stamp = stats
      .map((stat) => (stat === null ? "-" : `${stat.mtimeMs}:${stat.size}`))
      .join("|");
    const known = cache.get(folder);
    if (known !== undefined && known.stamp === stamp) return known.values;
    const values = new Set<string>();
    for (const [index, file] of files.entries()) {
      const stat = stats[index];
      if (stat === null || stat === undefined || !stat.isFile() || stat.size > 512 * 1024) continue;
      const text = await fsp.readFile(file, "utf8").catch(() => "");
      for (const value of envValues(text)) values.add(value);
    }
    const list = [...values];
    cache.set(folder, { stamp, values: list });
    return list;
  };
}
