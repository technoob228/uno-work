/**
 * Where app manifests live: `~/.uno/apps`, or `UNO_WORK_APPS_DIR` for tests
 * and local stands.
 */
import os from "node:os";
import path from "node:path";

export const MACHINE_APPS_DIR_ENV = "UNO_WORK_APPS_DIR";

export function resolveManifestDir(home = os.homedir()): string {
  const override = process.env[MACHINE_APPS_DIR_ENV]?.trim();
  return override && override.length > 0 ? path.resolve(override) : path.join(home, ".uno", "apps");
}

/** `~/.uno/apps` for people; the absolute path when it is somewhere else. */
export function displayManifestDir(dir: string, home = os.homedir()): string {
  return dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir;
}
