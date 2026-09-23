/**
 * `~/.uno/app-keys/<id>/` — where an app finds its App SDK token.
 *
 *   token     the bearer token (0600)
 *   api.json  {"appId","url","dockerUrl","token"} (0600)
 *   env       UNO_APP_ID=… UNO_APP_API_URL=… UNO_APP_TOKEN=… (0600, `source`-able)
 *
 * One folder per app, so a container mounts exactly its own folder
 * (`~/.uno/app-keys/notes:/run/uno-app:ro`) and never sees another app's key.
 * The folders are 0700: other Linux users and containers without the mount
 * cannot read them. Processes of the same user can — see docs/app-sdk.md.
 */
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const APP_KEYS_DIR_ENV = "UNO_WORK_APP_KEYS_DIR";

export function resolveAppKeysDir(home: string): string {
  const override = process.env[APP_KEYS_DIR_ENV]?.trim();
  return override && override.length > 0
    ? path.resolve(override)
    : path.join(home, ".uno", "app-keys");
}

export interface AppKeyEndpoints {
  readonly url: string;
  readonly dockerUrl: string | null;
}

export function appKeyDir(keysDir: string, appId: string): string {
  return path.join(keysDir, appId);
}

/** The variables an app started by its manifest command gets. */
export function appSdkEnv(
  appId: string,
  token: string,
  endpoints: AppKeyEndpoints,
): Record<string, string> {
  return {
    UNO_APP_ID: appId,
    UNO_APP_API_URL: endpoints.url,
    UNO_APP_TOKEN: token,
  };
}

export async function writeAppKey(
  keysDir: string,
  appId: string,
  token: string,
  endpoints: AppKeyEndpoints,
): Promise<void> {
  await mkdir(keysDir, { recursive: true, mode: 0o700 });
  const dir = appKeyDir(keysDir, appId);
  // A symlink in place of the folder would redirect the token elsewhere.
  const existing = await lstat(dir).catch(() => null);
  if (existing && !existing.isDirectory()) await rm(dir, { force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const files: Array<[string, string]> = [
    ["token", `${token}\n`],
    [
      "api.json",
      `${JSON.stringify({ appId, url: endpoints.url, dockerUrl: endpoints.dockerUrl, token }, null, 2)}\n`,
    ],
    [
      "env",
      `${Object.entries(appSdkEnv(appId, token, endpoints))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
    ],
  ];
  for (const [name, body] of files) {
    const file = path.join(dir, name);
    await rm(file, { force: true });
    await writeFile(file, body, { mode: 0o600, flag: "wx" });
  }
}

/** The token currently on disk for an app, or null. */
export async function readAppKeyToken(keysDir: string, appId: string): Promise<string | null> {
  try {
    const text = (await readFile(path.join(appKeyDir(keysDir, appId), "token"), "utf8")).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Withdraws an app's key. The folder itself stays (empty): a container that
 * bind-mounts it keeps seeing the same folder, so a key issued again later
 * (the person turns AI back on) reaches it without restarting the container.
 */
export async function removeAppKey(keysDir: string, appId: string): Promise<void> {
  const dir = appKeyDir(keysDir, appId);
  for (const name of ["token", "api.json", "env"]) {
    await rm(path.join(dir, name), { force: true });
  }
}

/** App ids that have a key folder (to clean up keys of removed manifests). */
export async function listAppKeyIds(keysDir: string): Promise<string[]> {
  try {
    return (await readdir(keysDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
