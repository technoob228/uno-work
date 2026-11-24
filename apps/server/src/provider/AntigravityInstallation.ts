/**
 * AntigravityInstallation — which `agy` a chat runs, and the one-click
 * install of Google's Antigravity CLI (Settings → AI → Antigravity →
 * Install): no terminal, no sudo, no npm.
 *
 * Which runtime, in order:
 *   1. the path in Settings → AI → Antigravity (binaryPath);
 *   2. the CLI Uno Work installed (`active.json` in the managed folder);
 *   3. `agy` on PATH (Homebrew, the official installer's ~/.local/bin,
 *      version-manager shims), then the official installer's usual places.
 * A file named anything but `agy` / `antigravity` is never picked from PATH:
 * the Antigravity *app* (the editor) is not the agent.
 *
 * The managed install follows upstream T3 Code (pingdotgg/t3code, MIT:
 * AntigravityInstallation.ts, antigravityCliRelease.ts): Google's release
 * manifest for this computer → download over https → sha512 check → the
 * single `antigravity` file from the archive (Windows ships `agy.exe`
 * itself) → `--version` must report the manifest's version → the version's
 * folder becomes active. A broken download never replaces a working CLI.
 *
 * @module AntigravityInstallation
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import nodePath from "node:path";

import { resolveHarnessExecutable } from "./acp/CustomAcpSupport.ts";
import {
  ANTIGRAVITY_CLI_MANIFEST_BASE,
  antigravityCliTarget,
  parseAntigravityCliRelease,
} from "./antigravityCliRelease.ts";

/** Where Uno Work keeps the Antigravity CLI it installed. */
export function antigravityManagedRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || nodePath.join(home, "AppData", "Local");
    return nodePath.join(local, "UnoWork", "antigravity");
  }
  const dataHome = env.XDG_DATA_HOME?.trim() || nodePath.join(home, ".local", "share");
  return nodePath.join(dataHome, "uno-work", "antigravity");
}

/** The official installer's and package managers' usual places for `agy`. */
export function antigravityKnownPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): ReadonlyArray<string> {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || nodePath.join(home, "AppData", "Local");
    return [
      nodePath.join(local, "agy", "bin", "agy.exe"),
      nodePath.join(local, "Programs", "agy", "agy.exe"),
      nodePath.join(home, ".local", "bin", "agy.exe"),
    ];
  }
  return [
    nodePath.join(home, ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    nodePath.join(home, ".antigravity", "bin", "agy"),
    nodePath.join(home, ".antigravity-cli", "bin", "agy"),
  ];
}

export type AntigravityExecutableSource = "settings" | "managed" | "path" | "known";

export type AntigravityExecutable =
  | { readonly ok: true; readonly path: string; readonly source: AntigravityExecutableSource }
  | { readonly ok: false; readonly reason: string };

interface ActiveRecord {
  readonly version: string;
  readonly executable: string;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    if (process.platform !== "win32") await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readActiveAntigravity(root: string): Promise<ActiveRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(nodePath.join(root, "active.json"), "utf8")) as {
      version?: unknown;
      executable?: unknown;
    };
    if (typeof parsed.version !== "string" || typeof parsed.executable !== "string")
      return undefined;
    // Only a file inside the managed folder: active.json is not a way to run anything else.
    const executable = nodePath.resolve(root, parsed.executable);
    if (!executable.startsWith(nodePath.resolve(root) + nodePath.sep)) return undefined;
    return (await isExecutable(executable)) ? { version: parsed.version, executable } : undefined;
  } catch {
    return undefined;
  }
}

const AGENT_NAMES = new Set(["agy", "agy.exe", "antigravity", "antigravity.exe"]);

/** Which `agy` a chat runs (see the module doc). */
export async function resolveAntigravityExecutable(input: {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}): Promise<AntigravityExecutable> {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? os.homedir();
  const custom = input.binaryPath.trim();
  if (custom) {
    const resolved = await resolveHarnessExecutable(custom, input.env);
    return resolved.ok
      ? { ok: true, path: resolved.path, source: "settings" }
      : { ok: false, reason: resolved.reason };
  }
  const managed = await readActiveAntigravity(antigravityManagedRoot(input.env, platform, home));
  if (managed) return { ok: true, path: managed.executable, source: "managed" };
  const onPath = await resolveHarnessExecutable("agy", input.env);
  if (onPath.ok && AGENT_NAMES.has(nodePath.basename(onPath.path).toLowerCase())) {
    return { ok: true, path: onPath.path, source: "path" };
  }
  for (const candidate of antigravityKnownPaths(input.env, platform, home)) {
    if (await isExecutable(candidate)) return { ok: true, path: candidate, source: "known" };
  }
  return {
    ok: false,
    reason: "the Antigravity CLI (`agy`) is not installed on this computer.",
  };
}

/* ------------------------------------------------------------------ *
 * Managed install
 * ------------------------------------------------------------------ */

export interface AntigravityInstallResult {
  readonly version: string;
  readonly executable: string;
}

export interface AntigravityInstallDeps {
  readonly fetch: typeof globalThis.fetch;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly musl: boolean;
  readonly root: string;
  readonly log: (line: string) => void;
  /** `<file> --version` → its output (stdout + stderr). */
  readonly version: (executable: string) => Promise<string>;
  /** Extracts the archive's `member` into `dir`. */
  readonly extract: (archive: string, dir: string, member: string) => Promise<void>;
}

const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

function run(command: string, args: ReadonlyArray<string>, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`${error.message}\n${String(stderr)}`.trim()));
        resolve(`${String(stdout)}${String(stderr)}`);
      },
    );
  });
}

async function isMusl(platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== "linux") return false;
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  if (report?.header?.glibcVersionRuntime) return false;
  try {
    return /musl/i.test(await run("ldd", ["--version"], 5_000));
  } catch (error) {
    return /musl/i.test(String(error));
  }
}

export async function defaultAntigravityInstallDeps(
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AntigravityInstallDeps> {
  const platform = process.platform;
  return {
    fetch: globalThis.fetch,
    platform,
    arch: process.arch,
    musl: await isMusl(platform),
    root: antigravityManagedRoot(env, platform),
    log,
    version: (executable) => run(executable, ["--version"], 30_000),
    // bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz and take a member name.
    extract: async (archive, dir, member) => {
      await run("tar", ["-xzf", archive, "-C", dir, member], 120_000);
    },
  };
}

/**
 * Installs (or updates to) Google's current Antigravity CLI for this
 * computer into the managed folder and makes it active.
 */
export async function installAntigravityCli(
  deps: AntigravityInstallDeps,
): Promise<AntigravityInstallResult> {
  const target = antigravityCliTarget(deps.platform, deps.arch, deps.musl);
  if (target === null) {
    throw new Error(`Antigravity has no build for ${deps.platform} ${deps.arch}.`);
  }
  deps.log(`Asking Google for the current Antigravity CLI (${target})…`);
  const manifestResponse = await deps.fetch(`${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json`, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!manifestResponse.ok) {
    throw new Error(`Google's release list answered ${manifestResponse.status}.`);
  }
  const release = parseAntigravityCliRelease(
    await manifestResponse.json(),
    deps.platform,
    deps.arch,
    deps.musl,
  );
  if (release === null) throw new Error("Google's release list has an unexpected shape.");

  const active = await readActiveAntigravity(deps.root);
  if (active?.version === release.version) {
    deps.log(`Antigravity ${release.version} is already installed.`);
    return active;
  }

  await mkdir(deps.root, { recursive: true });
  const staging = await mkdtemp(nodePath.join(deps.root, ".install-"));
  try {
    deps.log(`Downloading Antigravity ${release.version}…`);
    const response = await deps.fetch(release.url, {
      redirect: "error",
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`The download answered ${response.status}.`);
    }
    const hash = createHash("sha512");
    const download = nodePath.join(
      staging,
      release.format === "executable" ? "download.exe" : "cli.tar.gz",
    );
    const out = createWriteStream(download, { mode: 0o600 });
    let size = 0;
    let reported = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error("The download is larger than expected.");
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, "drain");
      if (size - reported >= 20 * 1024 * 1024) {
        reported = size;
        deps.log(`Downloaded ${Math.round(size / (1024 * 1024))} MB…`);
      }
    }
    out.end();
    await once(out, "finish");
    if (hash.digest("hex") !== release.sha512) {
      throw new Error("The download does not match Google's checksum; nothing was installed.");
    }
    deps.log("Checksum verified.");

    const versionDir = nodePath.join(staging, "cli");
    await mkdir(versionDir, { recursive: true });
    const executable = nodePath.join(versionDir, release.executable.name);
    if (release.format === "executable") {
      await rename(download, executable);
    } else {
      await deps.extract(download, versionDir, release.executable.name);
      await rm(download, { force: true });
    }
    if (deps.platform !== "win32") await chmod(executable, 0o755);

    const reportedVersion = await deps.version(executable);
    if (!reportedVersion.includes(release.version)) {
      throw new Error(
        `The installed CLI reports "${reportedVersion.trim().slice(0, 120)}", not ${release.version}.`,
      );
    }

    const finalDir = nodePath.join(deps.root, "versions", release.version);
    await rm(finalDir, { recursive: true, force: true });
    await mkdir(nodePath.dirname(finalDir), { recursive: true });
    await rename(versionDir, finalDir);
    const finalExecutable = nodePath.join(finalDir, release.executable.name);
    const record = {
      version: release.version,
      executable: nodePath.relative(deps.root, finalExecutable),
    };
    const activeTemp = nodePath.join(staging, "active.json");
    await writeFile(activeTemp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(activeTemp, nodePath.join(deps.root, "active.json"));
    deps.log(`Antigravity ${release.version} installed.`);

    // Older versions are dropped once the new one is active (a running chat keeps its file open).
    if (active && nodePath.dirname(active.executable) !== finalDir) {
      await rm(nodePath.dirname(active.executable), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    return { version: release.version, executable: finalExecutable };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
