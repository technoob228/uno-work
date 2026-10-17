/**
 * `uno::<name>` git remotes from any git on a cloud computer.
 *
 * git runs a remote helper as `git remote-uno …`: first `git-remote-uno` on
 * PATH, then an alias of that name. Agents have `~/.uno/sdk/bin` on PATH
 * (unoCliPath.ts), but the person's terminal in Work, apps and SSH sessions
 * don't (the daemon's PATH is the system's, and `~/.local/bin` is only added
 * by login shells). So on a cloud computer the daemon also sets, once, the
 * global alias `alias.remote-uno = !'<home>/.uno/sdk/bin/git-remote-uno'`,
 * which git falls back to wherever it runs under this user.
 *
 * Only on a cloud computer (the machine key is in settings): a person's own
 * laptop keeps its git config untouched. An alias of the same name the
 * person set themselves is left alone.
 *
 * @module appSdk/gitRemoteUno
 */
import { execFile } from "node:child_process";
import * as nodePath from "node:path";

import { GIT_REMOTE_UNO_BIN } from "./sdkFiles.ts";

export const GIT_REMOTE_UNO_ALIAS_KEY = "alias.remote-uno";

export interface GitConfigResult {
  readonly code: number;
  readonly stdout: string;
}

/** `!'<home>/.uno/sdk/bin/git-remote-uno'`, quoted for the shell git runs it with. */
export function gitRemoteUnoAliasValue(home: string): string {
  const helper = nodePath.join(home, ".uno", "sdk", GIT_REMOTE_UNO_BIN);
  return `!'${helper.replaceAll("'", `'\\''`)}'`;
}

/**
 * Sets the alias unless it is already ours and current, or is someone
 * else's. Throws when git refuses to write the config.
 */
export async function ensureGitRemoteUnoAlias(deps: {
  readonly home: string;
  readonly gitConfigGlobal: (args: ReadonlyArray<string>) => Promise<GitConfigResult>;
}): Promise<"added" | "kept" | "foreign"> {
  const want = gitRemoteUnoAliasValue(deps.home);
  const current = await deps.gitConfigGlobal(["--get", GIT_REMOTE_UNO_ALIAS_KEY]);
  const value = current.code === 0 ? current.stdout.trim() : "";
  if (value === want) return "kept";
  if (value !== "" && !value.includes(`/.uno/sdk/${GIT_REMOTE_UNO_BIN}`)) return "foreign";
  const set = await deps.gitConfigGlobal([GIT_REMOTE_UNO_ALIAS_KEY, want]);
  if (set.code !== 0) throw new Error(`git config --global ${GIT_REMOTE_UNO_ALIAS_KEY} failed`);
  return "added";
}

/** `git config --global …`: the exit code, never a throw (no git → 127). */
export function runGitConfigGlobal(
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitConfigResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["config", "--global", ...args],
      { env, timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
  });
}
