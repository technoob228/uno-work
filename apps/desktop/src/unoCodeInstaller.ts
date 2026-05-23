import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(ChildProcess.execFile);

const RELEASE_REPO = "technoob228/uno-code";
const ASSET_PREFIX = "uno-code";

export type InstallPhase = "fetching-release" | "downloading" | "extracting" | "verifying" | "done";

export interface InstallProgressEvent {
  phase: InstallPhase;
  percent?: number;
  message?: string;
}

export interface InstallerOptions {
  installDir: string;
  onProgress?: (event: InstallProgressEvent) => void;
}

export interface InstallResult {
  binaryPath: string;
  version: string;
  releaseTag: string;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  assets: ReadonlyArray<GitHubReleaseAsset>;
}

export type UnoCodeInstallErrorCode =
  | "unsupported-platform"
  | "release-fetch-failed"
  | "release-not-published"
  | "asset-missing"
  | "download-failed"
  | "extract-failed"
  | "verify-failed";

export class UnoCodeInstallError extends Error {
  readonly code: UnoCodeInstallErrorCode;
  constructor(message: string, code: UnoCodeInstallErrorCode) {
    super(message);
    this.name = "UnoCodeInstallError";
    this.code = code;
  }
}

function platformAssetName(): string {
  const { platform, arch } = process;
  if (platform === "darwin") {
    if (arch === "arm64") return `${ASSET_PREFIX}-darwin-arm64.zip`;
    if (arch === "x64") return `${ASSET_PREFIX}-darwin-x64.zip`;
  }
  if (platform === "linux") {
    if (arch === "arm64") return `${ASSET_PREFIX}-linux-arm64.tar.gz`;
    if (arch === "x64") return `${ASSET_PREFIX}-linux-x64.tar.gz`;
  }
  if (platform === "win32") {
    if (arch === "arm64") return `${ASSET_PREFIX}-windows-arm64.zip`;
    if (arch === "x64") return `${ASSET_PREFIX}-windows-x64.zip`;
  }
  throw new UnoCodeInstallError(
    `Uno Code is not available for ${platform}/${arch}.`,
    "unsupported-platform",
  );
}

function binaryFileName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "uno-work-installer",
      Accept: "application/vnd.github+json",
    },
  });
  if (response.status === 404) {
    throw new UnoCodeInstallError(
      "No Uno Code release is available yet. You can point Uno Work at a custom binary in Settings → Providers → Uno.",
      "release-not-published",
    );
  }
  if (!response.ok) {
    throw new UnoCodeInstallError(
      `GitHub API returned ${response.status} ${response.statusText} for ${url}`,
      "release-fetch-failed",
    );
  }
  return (await response.json()) as GitHubRelease;
}

async function downloadToFile(
  url: string,
  destPath: string,
  totalSize: number,
  onProgress: InstallerOptions["onProgress"],
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new UnoCodeInstallError(
      `Download failed: ${response.status} ${response.statusText}`,
      "download-failed",
    );
  }
  await FS.promises.mkdir(Path.dirname(destPath), { recursive: true });
  const writer = FS.createWriteStream(destPath);
  const reader = response.body.getReader();
  let downloaded = 0;
  let lastReportedPercent = -1;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!writer.write(value)) {
        await new Promise<void>((resolve) => writer.once("drain", resolve));
      }
      downloaded += value.byteLength;
      if (onProgress && totalSize > 0) {
        const percent = Math.min(99, Math.floor((downloaded / totalSize) * 100));
        if (percent > lastReportedPercent) {
          lastReportedPercent = percent;
          onProgress({ phase: "downloading", percent });
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writer.end((err: unknown) => (err ? reject(err) : resolve()));
    });
  }
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await FS.promises.mkdir(destDir, { recursive: true });
  try {
    if (archivePath.endsWith(".zip")) {
      if (process.platform === "win32") {
        await execFile("powershell", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
        ]);
      } else {
        await execFile("unzip", ["-o", "-q", archivePath, "-d", destDir]);
      }
    } else if (archivePath.endsWith(".tar.gz")) {
      await execFile("tar", ["-xzf", archivePath, "-C", destDir]);
    } else {
      throw new UnoCodeInstallError(`Unsupported archive format: ${archivePath}`, "extract-failed");
    }
  } catch (cause) {
    if (cause instanceof UnoCodeInstallError) throw cause;
    throw new UnoCodeInstallError(
      `Failed to extract ${Path.basename(archivePath)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      "extract-failed",
    );
  }
}

async function findExtractedBinary(extractDir: string): Promise<string> {
  const expectedName = binaryFileName(ASSET_PREFIX);
  const direct = Path.join(extractDir, expectedName);
  try {
    await FS.promises.access(direct, FS.constants.F_OK);
    return direct;
  } catch {
    // fallthrough — opencode may unpack into a nested folder
  }
  const entries = await FS.promises.readdir(extractDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = Path.join(extractDir, entry.name, expectedName);
      try {
        await FS.promises.access(nested, FS.constants.F_OK);
        return nested;
      } catch {
        // continue
      }
    }
  }
  throw new UnoCodeInstallError(
    `Extraction succeeded but no '${expectedName}' binary found in ${extractDir}`,
    "extract-failed",
  );
}

async function clearQuarantineMac(binaryPath: string): Promise<void> {
  if (process.platform !== "darwin") return;
  await execFile("xattr", ["-d", "com.apple.quarantine", binaryPath]).catch(() => undefined);
}

export async function installUnoCode(opts: InstallerOptions): Promise<InstallResult> {
  const { installDir, onProgress } = opts;
  await FS.promises.mkdir(installDir, { recursive: true });

  onProgress?.({ phase: "fetching-release", message: "Checking latest release…" });
  const release = await fetchLatestRelease();
  const assetName = platformAssetName();
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new UnoCodeInstallError(
      `No Uno Code build available for ${process.platform}/${process.arch} in release ${release.tag_name} yet. You can point Uno Work at a custom binary in Settings → Providers → Uno.`,
      "asset-missing",
    );
  }

  onProgress?.({
    phase: "downloading",
    percent: 0,
    message: `Downloading ${asset.name} (${Math.round(asset.size / 1024 / 1024)} MB)…`,
  });
  const archivePath = Path.join(installDir, "_download", asset.name);
  await downloadToFile(asset.browser_download_url, archivePath, asset.size, onProgress);

  onProgress?.({ phase: "extracting", message: "Extracting…" });
  const extractDir = Path.join(installDir, "bin");
  await FS.promises.rm(extractDir, { recursive: true, force: true });
  await extractArchive(archivePath, extractDir);

  const extracted = await findExtractedBinary(extractDir);
  const finalBinary = Path.join(extractDir, binaryFileName("uno-code"));
  if (extracted !== finalBinary) {
    await FS.promises.rename(extracted, finalBinary);
  }
  if (process.platform !== "win32") {
    await FS.promises.chmod(finalBinary, 0o755);
  }
  await clearQuarantineMac(finalBinary);

  onProgress?.({ phase: "verifying", message: "Verifying binary…" });
  let version: string;
  try {
    const { stdout } = await execFile(finalBinary, ["--version"]);
    version = stdout.trim();
  } catch (cause) {
    throw new UnoCodeInstallError(
      `Binary at ${finalBinary} failed to run --version: ${cause instanceof Error ? cause.message : String(cause)}`,
      "verify-failed",
    );
  }

  await FS.promises
    .rm(Path.dirname(archivePath), { recursive: true, force: true })
    .catch(() => undefined);

  onProgress?.({
    phase: "done",
    percent: 100,
    message: `Installed Uno Code ${version}`,
  });

  return { binaryPath: finalBinary, version, releaseTag: release.tag_name };
}

export function getDefaultInstallDir(stateDir: string): string {
  return Path.join(stateDir, "uno-code");
}

export function getDefaultBinaryPath(stateDir: string): string {
  return Path.join(stateDir, "uno-code", "bin", binaryFileName("uno-code"));
}

export async function isUnoCodeInstalled(binaryPath: string): Promise<boolean> {
  try {
    const mode = process.platform === "win32" ? FS.constants.F_OK : FS.constants.X_OK;
    await FS.promises.access(binaryPath, mode);
    return true;
  } catch {
    return false;
  }
}

export async function readUnoCodeVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(binaryPath, ["--version"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
