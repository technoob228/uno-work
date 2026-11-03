/**
 * Computers lifecycle (SPEC "Десктоп ставит помощника сам", CONTRACT.md §5):
 * the desktop app makes this computer one of the person's computers without a
 * terminal. The same steps as the install script the console serves at
 * `/c/<code>` (fishcode connect_assets/install.sh.tmpl), in the main process:
 *
 *   1. learn the console (`API`) and the download (`DOWNLOAD`) — from the
 *      pairing when it says, else from the install script itself;
 *   2. download `uno-connect-<os>-<arch>` and `SHA256SUMS`, check the sha256
 *      (fail closed: no published sum, no install);
 *   3. put it in `~/.uno-connect/uno-connect` (dir 0700, binary 0755;
 *      Windows `%LOCALAPPDATA%\UnoConnect\uno-connect.exe`), never as root;
 *   4. run `uno-connect pair --code C --api API` — the helper claims the code,
 *      saves its config and sets up its own autostart.
 *
 * Only https addresses on Uno's hosts are trusted for the script, the console
 * and the download. The helper's token stays in its own config: this module
 * reads only `computerId` and `name` from it.
 */
import * as Crypto from "node:crypto";
import * as Path from "node:path";

import type {
  DesktopConnectHelperInstallInput,
  DesktopConnectHelperInstallResult,
  DesktopConnectHelperState,
} from "@t3tools/contracts";

const TRUSTED_HOST = /(^|\.)(uno4\.work|getuno\.xyz|uno4\.dev|uno\.place)$/i;

export function isTrustedUnoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && TRUSTED_HOST.test(url.hostname) && url.username === "";
  } catch {
    return false;
  }
}

/** `API='…'` / `DOWNLOAD='…'` from the console's install script. */
export function parseInstallScript(script: string): { api: string; download: string } | null {
  const pick = (name: string) => new RegExp(`^${name}='([^'\\n]+)'$`, "m").exec(script)?.[1];
  const api = pick("API");
  const download = pick("DOWNLOAD");
  return api && download ? { api, download } : null;
}

export type HelperOs = "darwin" | "linux" | "windows";
export type HelperArch = "amd64" | "arm64";

export function helperPlatform(
  platform: NodeJS.Platform,
  arch: string,
): { os: HelperOs; arch: HelperArch } | null {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  return os && cpu ? { os, arch: cpu } : null;
}

export function helperAssetName(os: HelperOs, arch: HelperArch): string {
  return `uno-connect-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
}

/** The sum published for `name` in a SHA256SUMS file (`<hex>  <name>`). */
export function publishedSum(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const [hash, file] = line.trim().split(/\s+\*?/);
    if (file === name && hash && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

export function helperDir(input: {
  readonly os: HelperOs;
  readonly homeDir: string;
  readonly localAppData?: string | undefined;
}): string {
  if (input.os === "windows") {
    const base = input.localAppData ?? Path.join(input.homeDir, "AppData", "Local");
    return Path.win32.join(base, "UnoConnect");
  }
  return Path.join(input.homeDir, ".uno-connect");
}

export interface ConnectHelperDeps {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly homeDir: string;
  readonly localAppData?: string | undefined;
  /** True when the app runs as root / Administrator: the helper refuses that. */
  readonly isRoot: boolean;
  readonly fetchText: (url: string) => Promise<string>;
  readonly fetchBytes: (url: string) => Promise<Uint8Array>;
  readonly readFile: (path: string) => Promise<string | null>;
  readonly mkdirPrivate: (path: string) => Promise<void>;
  /** Writes the binary through a temporary file and renames it into place, mode 0755. */
  readonly writeExecutable: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Runs the helper; resolves with its exit code and the last lines it printed. */
  readonly run: (
    file: string,
    args: ReadonlyArray<string>,
  ) => Promise<{ readonly code: number | null; readonly output: string }>;
}

const fail = (step: string, message: string): DesktopConnectHelperInstallResult => ({
  ok: false,
  step,
  message,
});

export async function readConnectHelperState(
  deps: Pick<ConnectHelperDeps, "platform" | "arch" | "homeDir" | "localAppData" | "readFile">,
): Promise<DesktopConnectHelperState> {
  const platform = helperPlatform(deps.platform, deps.arch);
  if (!platform) return { installed: false, computerId: null, name: null };
  const dir = helperDir({
    os: platform.os,
    homeDir: deps.homeDir,
    localAppData: deps.localAppData,
  });
  const raw = await deps.readFile(Path.join(dir, "config.json")).catch(() => null);
  if (raw === null) return { installed: false, computerId: null, name: null };
  try {
    const config = JSON.parse(raw) as { computerId?: unknown; name?: unknown; token?: unknown };
    const id = config.computerId;
    const computerId =
      (typeof id === "number" && Number.isFinite(id) && id > 0) ||
      (typeof id === "string" && id !== "")
        ? String(id)
        : null;
    return {
      installed: computerId !== null && typeof config.token === "string" && config.token !== "",
      computerId,
      name: typeof config.name === "string" ? config.name : null,
    };
  } catch {
    return { installed: false, computerId: null, name: null };
  }
}

const CODE_PATTERN = /^[0-9A-Za-z-]{4,32}$/;

export async function installConnectHelper(
  deps: ConnectHelperDeps,
  input: DesktopConnectHelperInstallInput,
): Promise<DesktopConnectHelperInstallResult> {
  if (deps.isRoot)
    return fail("root", "Uno Work is running as an administrator. Open it as yourself.");
  const platform = helperPlatform(deps.platform, deps.arch);
  if (!platform) return fail("os", "This computer isn’t supported yet.");
  if (!CODE_PATTERN.test(input.code)) return fail("code", "The code is wrong. Try again.");

  let api = input.api;
  let download = input.download;
  if (!api || !download) {
    if (!isTrustedUnoUrl(input.url)) return fail("script", "Uno gave an unexpected address.");
    let script: string;
    try {
      script = await deps.fetchText(input.url);
    } catch {
      return fail("download", "Couldn’t reach Uno. Check the internet connection and try again.");
    }
    const parsed = parseInstallScript(script);
    if (!parsed) return fail("script", "Uno gave an unexpected answer. Try again.");
    api ??= parsed.api;
    download ??= parsed.download;
  }
  if (!isTrustedUnoUrl(api) || !isTrustedUnoUrl(download)) {
    return fail("script", "Uno gave an unexpected address.");
  }
  const base = download.replace(/\/+$/, "");
  const asset = helperAssetName(platform.os, platform.arch);

  let binary: Uint8Array;
  let sums: string;
  try {
    [binary, sums] = await Promise.all([
      deps.fetchBytes(`${base}/${asset}`),
      deps.fetchText(`${base}/SHA256SUMS`),
    ]);
  } catch {
    return fail("download", "Couldn’t download Uno’s helper. Check the internet connection.");
  }
  const want = publishedSum(sums, asset);
  if (!want) return fail("checksum", "No checksum was published for this computer.");
  const got = Crypto.createHash("sha256").update(binary).digest("hex");
  if (got !== want) return fail("checksum", "The download is damaged. Try again.");

  const dir = helperDir({
    os: platform.os,
    homeDir: deps.homeDir,
    localAppData: deps.localAppData,
  });
  const exe =
    platform.os === "windows"
      ? Path.win32.join(dir, "uno-connect.exe")
      : Path.join(dir, "uno-connect");
  try {
    await deps.mkdirPrivate(dir);
    await deps.writeExecutable(exe, binary);
  } catch {
    return fail("install", `Couldn’t put Uno’s helper in ${dir}.`);
  }

  let result: { code: number | null; output: string };
  try {
    result = await deps.run(exe, ["pair", "--code", input.code, "--api", api]);
  } catch {
    return fail("start", "Uno’s helper couldn’t start on this computer.");
  }
  if (result.code !== 0) {
    // The helper says why in plain words on its last line (pair.go `stop`).
    const last = result.output
      .trim()
      .split(/\r?\n/)
      .pop()
      ?.replace(/^Uno Connect:\s*/, "");
    return fail("pair", last && last.length < 300 ? last : "This computer didn’t connect.");
  }
  return { ok: true };
}
