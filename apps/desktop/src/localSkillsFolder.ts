/**
 * "Import from this computer" on the skills step: the person's own skills
 * folder on the laptop (Claude Code's `~/.claude/skills`, Codex's
 * `~/.agents/skills` or `~/.codex/skills`) is read here, in the main
 * process, after they pick it in the system's folder dialog — so nothing is
 * read without their click. The files go to the web app, which zips them and
 * sends them to the Work computer's import (preview first, nothing runs).
 *
 * Bounded: 25 MB and 5,000 files. Skill folders that are links (people keep
 * skills in a repo and link them in) are followed one level; links inside a
 * skill aren't. Hidden folders (Codex's built-in `.system`), `.git` and
 * `node_modules` are left out.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as Path from "node:path";

export const LOCAL_SKILLS_MAX_BYTES = 25 * 1024 * 1024;
export const LOCAL_SKILLS_MAX_FILES = 5_000;

export interface LocalSkillsFile {
  readonly path: string;
  readonly data: Uint8Array;
}

export interface LocalSkillsFolder {
  readonly folder: string;
  readonly files: ReadonlyArray<LocalSkillsFile>;
}

export class LocalSkillsError extends Error {}

/** Where the dialog opens: the first agent skills folder that exists. */
export function defaultSkillsFolder(home: string): string {
  const candidates = [
    Path.join(home, ".claude", "skills"),
    Path.join(home, ".agents", "skills"),
    Path.join(home, ".codex", "skills"),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? home;
}

const SKIP = new Set([".git", "node_modules", "__MACOSX", ".DS_Store", "Thumbs.db"]);

export async function readLocalSkillsFolder(folder: string): Promise<LocalSkillsFolder> {
  const root = await fs.realpath(folder);
  const files: LocalSkillsFile[] = [];
  let total = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.startsWith("._")) continue;
      if (depth === 0 && entry.name.startsWith(".")) continue;
      const full = Path.join(dir, entry.name);
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink() && depth === 0) {
        const stat = await fs.stat(full).catch(() => null);
        isDir = stat?.isDirectory() === true;
        isFile = false;
      }
      if (isDir) {
        await walk(full, path, depth + 1);
      } else if (isFile) {
        if (files.length >= LOCAL_SKILLS_MAX_FILES) {
          throw new LocalSkillsError("This folder has more than 5,000 files. Pick a smaller one.");
        }
        const data = new Uint8Array(await fs.readFile(full));
        total += data.length;
        if (total > LOCAL_SKILLS_MAX_BYTES) {
          throw new LocalSkillsError("This folder holds more than 25 MB. Pick a smaller one.");
        }
        files.push({ path, data });
      }
    }
  };
  await walk(root, "", 0);
  return { folder: root, files };
}
