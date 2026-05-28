import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(ChildProcess.execFile);

const RELEASE_REPO = "technoob228/uno-code";
const ASSET_PREFIX = "uno-code";

const RELEASE_FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 2_000;

export type InstallPhase =
  | "fetching-release"
  | "downloading"
  | "validating"
  | "extracting"
  | "verifying"
  | "done";

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
  checksumVerified: boolean;
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
  | "checksum-mismatch"
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

// Terminal failures: retrying within a single install run cannot help.
const TERMINAL_ERROR_CODES: ReadonlySet<UnoCodeInstallErrorCode> = new Set([
  "unsupported-platform",
  "release-not-published",
  "asset-missing",
]);

function isRetriableError(error: unknown): boolean {
  if (error instanceof UnoCodeInstallError) return !TERMINAL_ERROR_CODES.has(error.code);
  // Network/abort/DNS errors thrown by fetch are plain Errors — retry them.
  return true;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function withIdleTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new UnoCodeInstallError(message, "download-failed"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (cause) {
      lastError = cause;
      if (!isRetriableError(cause) || attempt === RETRY_ATTEMPTS - 1) throw cause;
      await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
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

function isRateLimited(response: Response): boolean {
  return response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0";
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "uno-work-installer",
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
  });
  if (response.status === 404) {
    throw new UnoCodeInstallError(
      "No Uno Code release is available yet. You can point Uno Work at a custom binary in Settings → Providers → Uno.",
      "release-not-published",
    );
  }
  if (isRateLimited(response)) {
    // Retriable: the unauthenticated GitHub limit (60/h per IP) is commonly hit
    // behind corporate NAT. withRetry backoff gives the window time to reset.
    throw new UnoCodeInstallError(
      "GitHub API rate limit reached while checking for the latest Uno Code release. Retrying shortly…",
      "release-fetch-failed",
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
  const response = await fetch(url, { signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS) });
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
      const { done, value } = await withIdleTimeout(
        reader.read(),
        DOWNLOAD_IDLE_TIMEOUT_MS,
        "Download stalled (no data received).",
      );
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

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = Crypto.createHash("sha256");
  const stream = FS.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function findChecksumAsset(release: GitHubRelease): GitHubReleaseAsset | undefined {
  return release.assets.find((a) => {
    const name = a.name.toLowerCase();
    return name.includes("checksum") || name.endsWith(".sha256") || name === "sha256sums.txt";
  });
}

// Parses common checksum-file formats ("<hex>  <filename>" per line) and
// returns the expected hash for `assetName`, or null if absent.
function parseChecksum(content: string, assetName: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const hex = match[1];
    const file = match[2];
    if (!hex || !file) continue;
    if (Path.basename(file.trim()) === assetName) return hex.toLowerCase();
  }
  return null;
}

// Best-effort: verifies the archive against the release checksum file when one
// exists. Returns true only when a matching checksum was found AND matched.
// Throws checksum-mismatch when a checksum exists but disagrees (retriable so a
// corrupted download is re-fetched). Returns false when no checksum is published.
async function verifyChecksum(
  release: GitHubRelease,
  assetName: string,
  archivePath: string,
): Promise<boolean> {
  const checksumAsset = findChecksumAsset(release);
  if (!checksumAsset) return false;
  let expected: string | null = null;
  try {
    const response = await fetch(checksumAsset.browser_download_url, {
      headers: { "User-Agent": "uno-work-installer" },
      signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    expected = parseChecksum(await response.text(), assetName);
  } catch {
    return false;
  }
  if (!expected) return false;
  const actual = await sha256OfFile(archivePath);
  if (actual !== expected) {
    throw new UnoCodeInstallError(
      `Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}.`,
      "checksum-mismatch",
    );
  }
  return true;
}

export async function installUnoCode(opts: InstallerOptions): Promise<InstallResult> {
  const { installDir, onProgress } = opts;
  await FS.promises.mkdir(installDir, { recursive: true });

  const binDir = Path.join(installDir, "bin");
  const stagingDir = Path.join(installDir, `.staging-${Crypto.randomUUID()}`);
  const downloadDir = Path.join(installDir, "_download");

  try {
    onProgress?.({ phase: "fetching-release", message: "Checking latest release…" });
    const release = await withRetry(() => fetchLatestRelease());
    const assetName = platformAssetName();
    const asset = release.assets.find((a) => a.name === assetName);
    if (!asset) {
      throw new UnoCodeInstallError(
        `No Uno Code build available for ${process.platform}/${process.arch} in release ${release.tag_name} yet. You can point Uno Work at a custom binary in Settings → Providers → Uno.`,
        "asset-missing",
      );
    }

    const archivePath = Path.join(downloadDir, asset.name);
    // Download + checksum together so a corrupted archive is re-fetched on retry.
    const checksumVerified = await withRetry(async () => {
      onProgress?.({
        phase: "downloading",
        percent: 0,
        message: `Downloading ${asset.name} (${Math.round(asset.size / 1024 / 1024)} MB)…`,
      });
      await downloadToFile(asset.browser_download_url, archivePath, asset.size, onProgress);
      onProgress?.({ phase: "validating", message: "Verifying download integrity…" });
      return verifyChecksum(release, assetName, archivePath);
    });

    onProgress?.({ phase: "extracting", message: "Extracting…" });
    await FS.promises.rm(stagingDir, { recursive: true, force: true });
    await extractArchive(archivePath, stagingDir);

    const extracted = await findExtractedBinary(stagingDir);
    const stagedBinary = Path.join(stagingDir, binaryFileName("uno-code"));
    if (extracted !== stagedBinary) {
      await FS.promises.rename(extracted, stagedBinary);
    }
    if (process.platform !== "win32") {
      await FS.promises.chmod(stagedBinary, 0o755);
    }
    await clearQuarantineMac(stagedBinary);

    onProgress?.({ phase: "verifying", message: "Verifying binary…" });
    let version: string;
    try {
      const { stdout } = await execFile(stagedBinary, ["--version"]);
      version = stdout.trim();
    } catch (cause) {
      throw new UnoCodeInstallError(
        `Binary at ${stagedBinary} failed to run --version: ${cause instanceof Error ? cause.message : String(cause)}`,
        "verify-failed",
      );
    }

    // Atomic swap: only replace a working bin/ once staging fully validated.
    await FS.promises.rm(binDir, { recursive: true, force: true });
    await FS.promises.rename(stagingDir, binDir);
    const finalBinary = Path.join(binDir, binaryFileName("uno-code"));

    onProgress?.({
      phase: "done",
      percent: 100,
      message: `Installed Uno Code ${version}`,
    });

    return { binaryPath: finalBinary, version, releaseTag: release.tag_name, checksumVerified };
  } finally {
    await FS.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    await FS.promises.rm(downloadDir, { recursive: true, force: true }).catch(() => undefined);
  }
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
