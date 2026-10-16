/**
 * Where the `uno` shell command lives (`~/.uno/sdk/bin/uno`, written by
 * sdkFiles.ts) and how agents find it: the folder goes first on PATH of every
 * harness process, next to the bridge variables the command needs.
 */
import * as nodePath from "node:path";

/** Relative to `~/.uno/sdk`. */
export const UNO_CLI_BIN_RELATIVE = "bin";

export function unoCliBinDir(home: string): string {
  return nodePath.join(home, ".uno", "sdk", UNO_CLI_BIN_RELATIVE);
}

/**
 * Prepend `~/.uno/sdk/bin` to PATH unless it is already there. No-op on
 * Windows and without a PATH (setting one would hide the system's defaults).
 */
export function withUnoCliOnPath(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === "win32" || !env.PATH) return env;
  const bin = unoCliBinDir(home);
  const entries = env.PATH.split(nodePath.delimiter).filter((entry) => entry.length > 0);
  if (entries.includes(bin)) return env;
  return { ...env, PATH: [bin, ...entries].join(nodePath.delimiter) };
}
