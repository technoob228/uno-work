import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function isGitRepository(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

/**
 * A checkpoint copies the whole workspace. The home folder is everything the
 * person owns, so a stray `~/.git` must not turn each turn into a copy of it.
 */
export function isCheckpointWorkspace(cwd: string): boolean {
  return isGitRepository(cwd) && resolve(cwd) !== resolve(homedir());
}
