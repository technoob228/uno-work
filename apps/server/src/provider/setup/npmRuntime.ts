/**
 * Where the npm-installed agents (Codex, Claude Code, Gemini CLI, Grok,
 * OpenCode) get their npm from.
 *
 * A Mac app started from the Dock does not see the Terminal's PATH. The
 * daemon reads it from the login shell at start (os-jank `fixPath`), but that
 * can time out, and nvm / fnm put node in a folder only a shell hook knows.
 * So the install first looks for a working npm on PATH and in the usual
 * places (Homebrew, nvm, fnm, Volta, asdf, mise, n, MacPorts).
 *
 * A Mac without Node at all (T64, 24.11: "npm" was not found, Install was a
 * dead end) gets Node.js from nodejs.org into `~/.uno/node`: the official
 * build of a pinned LTS, its SHA-256 checked against the value below, no
 * sudo, nothing outside that folder. The agents then install into that
 * folder's own prefix, and the daemon keeps `~/.uno/node/bin` last on its
 * PATH (`withManagedNodeOnPath`), so their `#!/usr/bin/env node` finds it
 * while a Node the person has keeps winning.
 *
 * @module provider/setup/npmRuntime
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  constants as fsConstants,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import * as nodePath from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { ProviderInstallHelp } from "@t3tools/contracts";

/* ------------------------------------------------------------------ *
 * The Node.js Uno Work brings when the machine has none
 * ------------------------------------------------------------------ */

/**
 * Node 24 LTS (Krypton). Hashes are from nodejs.org/dist/v24.22.3/SHASUMS256.txt,
 * whose release signature was checked against nodejs/release-keys (24.11.2026).
 * An upgrade is a deliberate change of the version and all four hashes.
 */
export const MANAGED_NODE_VERSION = "24.22.3";

const MANAGED_NODE_SHA256: Readonly<Record<string, string>> = {
  "darwin-arm64": "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
  "darwin-x64": "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
  "linux-arm64": "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8",
  "linux-x64": "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2",
};

export interface ManagedNodeDownload {
  readonly url: string;
  readonly sha256: string;
  /** Top folder inside the archive. */
  readonly folder: string;
}

/** The archive for this platform, or null where Uno Work brings no Node (Windows, 32-bit…). */
export function managedNodeDownload(
  platform: NodeJS.Platform,
  arch: string,
): ManagedNodeDownload | null {
  const key = `${platform}-${arch}`;
  const sha256 = MANAGED_NODE_SHA256[key];
  if (!sha256) return null;
  const folder = `node-v${MANAGED_NODE_VERSION}-${key}`;
  return {
    url: `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/${folder}.tar.gz`,
    sha256,
    folder,
  };
}

/** `~/.uno/node` — Uno Work's own Node.js, next to `~/.uno/sdk`. */
export function managedNodeDir(homeDir: string): string {
  return nodePath.join(homeDir, ".uno", "node");
}

export function managedNodeBinDir(homeDir: string): string {
  return nodePath.join(managedNodeDir(homeDir), "bin");
}

/**
 * `~/.uno/node/bin` last on PATH (not on Windows). A missing folder on PATH
 * costs nothing, so this holds from the daemon's start: agents installed
 * later into that folder are found without a restart.
 */
export function withManagedNodeOnPath(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === "win32") return env;
  const bin = managedNodeBinDir(homeDir);
  const entries = (env.PATH ?? "").split(nodePath.delimiter).filter((entry) => entry.length > 0);
  if (entries.includes(bin)) return env;
  return { ...env, PATH: [...entries, bin].join(nodePath.delimiter) };
}

/* ------------------------------------------------------------------ *
 * Finding an npm that works
 * ------------------------------------------------------------------ */

export interface DirReader {
  readonly list: (dir: string) => Promise<ReadonlyArray<string>>;
  readonly isExecutable: (file: string) => Promise<boolean>;
}

const realDirReader: DirReader = {
  list: (dir) => readdir(dir).catch(() => []),
  isExecutable: (file) =>
    access(file, fsConstants.X_OK).then(
      () => stat(file).then((info) => info.isFile()),
      () => false,
    ),
};

/** "v22.11.0" / "22.11.0" → [22, 11, 0]; anything else sorts last. */
function versionKey(name: string): ReadonlyArray<number> {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(name);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [-1, -1, -1];
}

function newestFirst(names: ReadonlyArray<string>): ReadonlyArray<string> {
  return names.toSorted((a, b) => {
    const [ka, kb] = [versionKey(a), versionKey(b)];
    for (let index = 0; index < 3; index += 1) {
      const diff = (kb[index] ?? 0) - (ka[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

/**
 * Folders that may hold `npm` next to its `node`, most likely first: PATH as
 * the daemon has it, then where the usual installers put Node on macOS and
 * Linux, then Uno Work's own Node. Unix only.
 */
export async function npmCandidateDirs(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly reader?: DirReader;
}): Promise<ReadonlyArray<string>> {
  const reader = input.reader ?? realDirReader;
  const home = input.homeDir;
  const env = input.env;
  const dirs: string[] = [];
  const add = (dir: string | undefined) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  /** `<root>/<version>/<suffix>` for every version folder, newest first. */
  const versions = async (root: string, suffix: string) => {
    for (const name of newestFirst(await reader.list(root))) add(nodePath.join(root, name, suffix));
  };

  for (const entry of (env.PATH ?? "").split(nodePath.delimiter)) add(entry.trim() || undefined);

  add("/opt/homebrew/bin");
  add("/usr/local/bin");
  // nvm: the default alias is a shell function's choice; newest is a good guess.
  await versions(
    nodePath.join(env.NVM_DIR?.trim() || nodePath.join(home, ".nvm"), "versions", "node"),
    "bin",
  );
  // fnm keeps its versions in the platform's data folder.
  for (const fnmRoot of [
    env.FNM_DIR?.trim(),
    nodePath.join(home, "Library", "Application Support", "fnm"),
    nodePath.join(env.XDG_DATA_HOME?.trim() || nodePath.join(home, ".local", "share"), "fnm"),
    nodePath.join(home, ".fnm"),
  ]) {
    if (fnmRoot) await versions(nodePath.join(fnmRoot, "node-versions"), "installation/bin");
  }
  add(nodePath.join(env.VOLTA_HOME?.trim() || nodePath.join(home, ".volta"), "bin"));
  add(nodePath.join(env.ASDF_DATA_DIR?.trim() || nodePath.join(home, ".asdf"), "shims"));
  add(nodePath.join(home, ".local", "share", "mise", "shims"));
  add(nodePath.join(home, ".nodenv", "shims"));
  add(nodePath.join(env.N_PREFIX?.trim() || nodePath.join(home, "n"), "bin"));
  add("/opt/local/bin");
  add("/usr/bin");
  add(managedNodeBinDir(home));

  const usable: string[] = [];
  for (const dir of dirs) {
    if (
      (await reader.isExecutable(nodePath.join(dir, "npm"))) &&
      (await reader.isExecutable(nodePath.join(dir, "node")))
    ) {
      usable.push(dir);
    }
  }
  return usable;
}

export interface NpmRuntime {
  /** Absolute path of `npm` (just "npm" on Windows: the shell finds it). */
  readonly npm: string;
  /** Goes first on PATH for the install, so npm's own `env node` is that node. */
  readonly binDir: string | undefined;
  /** npm's global prefix is writable by this user. */
  readonly globalWritable: boolean;
  /** It is Uno Work's own Node in `~/.uno/node`. */
  readonly managed: boolean;
}

/** `npm prefix -g` with that folder first on PATH; null when npm does not run. */
export type NpmPrefixProbe = (input: {
  readonly npm: string;
  readonly env: NodeJS.ProcessEnv;
}) => Promise<string | null>;

export const probeNpmPrefix: NpmPrefixProbe = ({ npm, env }) =>
  new Promise((resolve) => {
    let output = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(npm, ["prefix", "-g"], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        shell: process.platform === "win32",
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const prefix = output.trim();
      resolve(code === 0 && prefix.length > 0 ? prefix : null);
    });
  });

const isWritableDir = (dir: string): Promise<boolean> =>
  access(dir, fsConstants.W_OK).then(
    () => true,
    () => false,
  );

const prefixWritable = async (prefix: string, platform: NodeJS.Platform): Promise<boolean> =>
  platform === "win32"
    ? isWritableDir(prefix)
    : (await isWritableDir(nodePath.join(prefix, "lib", "node_modules"))) || isWritableDir(prefix);

/** PATH with `dir` first. */
export function withDirFirstOnPath(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const rest = (env.PATH ?? "")
    .split(nodePath.delimiter)
    .filter((entry) => entry.length > 0 && entry !== dir);
  return { ...env, PATH: [dir, ...rest].join(nodePath.delimiter) };
}

/** The first npm here that answers `npm prefix -g`, or null. */
export async function locateNpm(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly probe?: NpmPrefixProbe;
  readonly reader?: DirReader;
  readonly isWritable?: (prefix: string) => Promise<boolean>;
}): Promise<NpmRuntime | null> {
  const probe = input.probe ?? probeNpmPrefix;
  const isWritable = input.isWritable ?? ((prefix) => prefixWritable(prefix, input.platform));
  if (input.platform === "win32") {
    const prefix = await probe({ npm: "npm", env: input.env });
    return prefix === null
      ? null
      : { npm: "npm", binDir: undefined, globalWritable: await isWritable(prefix), managed: false };
  }
  const managedBin = managedNodeBinDir(input.homeDir);
  for (const dir of await npmCandidateDirs({
    env: input.env,
    homeDir: input.homeDir,
    ...(input.reader ? { reader: input.reader } : {}),
  })) {
    const npm = nodePath.join(dir, "npm");
    const prefix = await probe({ npm, env: withDirFirstOnPath(input.env, dir) });
    if (prefix === null) continue;
    return {
      npm,
      binDir: dir,
      globalWritable: await isWritable(prefix),
      managed: dir === managedBin,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Installing Uno Work's own Node.js
 * ------------------------------------------------------------------ */

export interface ManagedNodeInstallDeps {
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly fetch?: typeof globalThis.fetch;
  /** `tar -xzf <archive> -C <dir>`; resolves on exit 0. */
  readonly extract?: (archive: string, dir: string) => Promise<void>;
  /** Runs `<node> --version`; resolves with its output. */
  readonly checkNode?: (nodeBin: string) => Promise<string>;
  /** Tests only: the checksum to expect instead of the pinned one. */
  readonly sha256Override?: string;
}

const runQuiet = (command: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (output += chunk));
    child.stderr?.on("data", (chunk: string) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(`${nodePath.basename(command)} exited with code ${code}: ${output.trim()}`),
          ),
    );
  });

const defaultExtract = (archive: string, dir: string) =>
  runQuiet("tar", ["-xzf", archive, "-C", dir]).then(() => undefined);

const defaultCheckNode = (nodeBin: string) => runQuiet(nodeBin, ["--version"]);

/** Why getting Node failed, in words for the card. */
export type ManagedNodeFailure = "unsupported" | "download" | "checksum" | "unpack";

export class ManagedNodeError extends Error {
  readonly reason: ManagedNodeFailure;
  constructor(message: string, reason: ManagedNodeFailure) {
    super(message);
    this.name = "ManagedNodeError";
    this.reason = reason;
  }
}

/**
 * Download, verify and unpack Node.js into `~/.uno/node`. A partial download
 * or unpack never replaces a working folder: it is staged next to it first.
 */
export async function installManagedNode(
  deps: ManagedNodeInstallDeps,
  log: (line: string) => void,
): Promise<void> {
  const download = managedNodeDownload(deps.platform, deps.arch);
  if (!download) {
    throw new ManagedNodeError(
      `Uno Work cannot bring Node.js for ${deps.platform}-${deps.arch}.`,
      "unsupported",
    );
  }
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const target = managedNodeDir(deps.homeDir);
  const parent = nodePath.dirname(target);
  await mkdir(parent, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const archive = nodePath.join(parent, `.node-download-${stamp}.tar.gz`);
  const staging = nodePath.join(parent, `.node-staging-${stamp}`);

  try {
    log(
      `Node.js was not found here: getting Node.js ${MANAGED_NODE_VERSION} for Uno Work from nodejs.org…\n`,
    );
    let response: Response;
    try {
      response = await fetchImpl(download.url);
    } catch (error) {
      throw new ManagedNodeError(
        `Could not reach nodejs.org (${error instanceof Error ? error.message : String(error)}).`,
        "download",
      );
    }
    if (!response.ok || !response.body) {
      throw new ManagedNodeError(
        `nodejs.org answered ${response.status} for ${download.url}.`,
        "download",
      );
    }
    const total = Number(response.headers.get("content-length") ?? 0);
    const hash = createHash("sha256");
    let received = 0;
    let reported = 0;
    const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
      if (percent >= reported + 25 && percent < 100) {
        reported = percent - (percent % 25);
        log(`Downloading Node.js… ${reported}%\n`);
      }
    });
    try {
      await pipeline(body, createWriteStream(archive));
    } catch (error) {
      throw new ManagedNodeError(
        `The Node.js download broke off (${error instanceof Error ? error.message : String(error)}).`,
        "download",
      );
    }
    const digest = hash.digest("hex");
    if (digest !== (deps.sha256Override ?? download.sha256)) {
      throw new ManagedNodeError(
        "The downloaded Node.js did not match its published checksum, so it was not used.",
        "checksum",
      );
    }
    log("Checksum verified. Unpacking…\n");

    await mkdir(staging, { recursive: true });
    try {
      await (deps.extract ?? defaultExtract)(archive, staging);
      const unpacked = nodePath.join(staging, download.folder);
      const version = (
        await (deps.checkNode ?? defaultCheckNode)(nodePath.join(unpacked, "bin", "node"))
      ).trim();
      // Swap in: the old folder (a broken earlier attempt) goes only once the new one is ready.
      const old = `${target}.old-${stamp}`;
      const hadOld = await stat(target).then(
        () => true,
        () => false,
      );
      if (hadOld) await rename(target, old);
      await rename(unpacked, target);
      if (hadOld) await rm(old, { recursive: true, force: true });
      log(`Node.js ${version} is ready in ${target}.\n`);
    } catch (error) {
      throw new ManagedNodeError(
        `Could not unpack Node.js (${error instanceof Error ? error.message : String(error)}).`,
        "unpack",
      );
    }
  } finally {
    await rm(archive, { force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ *
 * The card when nothing worked
 * ------------------------------------------------------------------ */

interface NpmAgentInfo {
  readonly label: string;
  readonly npmPackage: string;
  readonly docsUrl: string;
  /** A Homebrew package the vendor documents, used when brew is there. */
  readonly brew?: string;
}

const NPM_AGENT_INFO: Readonly<Record<string, NpmAgentInfo>> = {
  codex: {
    label: "Codex",
    npmPackage: "@openai/codex",
    docsUrl: "https://github.com/openai/codex",
    brew: "brew install --cask codex",
  },
  claudeAgent: {
    label: "Claude Code",
    npmPackage: "@anthropic-ai/claude-code",
    docsUrl: "https://code.claude.com/docs/en/setup",
  },
  gemini: {
    label: "Gemini CLI",
    npmPackage: "@google/gemini-cli",
    docsUrl: "https://geminicli.com/docs/get-started/installation/",
    brew: "brew install gemini-cli",
  },
  grok: {
    label: "Grok",
    npmPackage: "@xai-official/grok",
    docsUrl: "https://www.npmjs.com/package/@xai-official/grok",
  },
  opencode: {
    label: "OpenCode",
    npmPackage: "opencode-ai",
    docsUrl: "https://opencode.ai/docs/",
  },
};

export const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";

/**
 * What the person can do when Install could not get Node.js: one plain
 * sentence, the command for this machine, the vendor's install page.
 */
export function npmMissingHelp(input: {
  readonly driver: string;
  readonly platform: NodeJS.Platform;
  readonly brewAvailable: boolean;
  /** Why Uno Work's own Node did not come, if it tried. */
  readonly managedNodeError?: ManagedNodeError;
}): ProviderInstallHelp {
  const info = NPM_AGENT_INFO[input.driver] ?? {
    label: input.driver,
    npmPackage: input.driver,
    docsUrl: NODE_DOWNLOAD_URL,
  };
  const machine = input.platform === "darwin" ? "this Mac" : "this computer";
  const reason = input.managedNodeError;
  const why =
    reason?.reason === "download"
      ? "Uno Work tried to download Node.js but could not reach nodejs.org."
      : reason?.reason === "checksum"
        ? "Uno Work downloaded Node.js, but the file was damaged on the way, so it was not used."
        : reason?.reason === "unpack"
          ? "Uno Work downloaded Node.js but could not unpack it."
          : undefined;

  const viaBrew = input.brewAvailable
    ? (info.brew ?? `brew install node && npm install -g ${info.npmPackage}`)
    : undefined;
  return {
    title: `${info.label} needs Node.js, and ${machine} doesn't have it yet.`,
    ...(why ? { detail: why } : {}),
    ...(viaBrew
      ? {
          command: viaBrew,
          commandNote: "Paste it into Terminal, then press Check again.",
        }
      : {
          command: `npm install -g ${info.npmPackage}`,
          commandNote:
            "Install Node.js first (link below), then run this in Terminal and press Check again.",
          nodeUrl: NODE_DOWNLOAD_URL,
        }),
    docsUrl: info.docsUrl,
    docsLabel: `${info.label} install guide`,
  };
}
