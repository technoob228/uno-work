/**
 * Installs the office engine package (see officeEngine.ts) on this machine from
 * Uno's own host, with a pinned sha256. Runs in the background: the Office
 * screen starts it with one button and polls the status.
 *
 * The package is a re-hosted, unmodified ONLYOFFICE build (AGPL-3.0), repacked
 * as tar.gz with the layout the daemon serves (`vendor/`, `LICENSE.txt`), so
 * no `unzip` is needed on the machine.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { OFFICE_ENGINE_API_SCRIPT } from "./officeEngine.ts";

export const OFFICE_ENGINE_PACKAGE = {
  url:
    process.env.UNO_OFFICE_ENGINE_URL ??
    "https://console.uno4.dev/cli/work/office-engine/office-engine-oo13.tar.gz",
  sha256:
    process.env.UNO_OFFICE_ENGINE_SHA256 ??
    "5269aa464d77200637a8abe7c4fb2b1ce123e88deb3b89811be54ac5545c6c28",
  approxBytes: 319_175_735,
} as const;

export type OfficeEngineInstallState = "idle" | "installing" | "installed" | "error";

export interface OfficeEngineStatus {
  readonly installed: boolean;
  readonly state: OfficeEngineInstallState;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly error: string | null;
}

interface MutableStatus {
  state: OfficeEngineInstallState;
  receivedBytes: number;
  totalBytes: number;
  error: string | null;
}

const status: MutableStatus = {
  state: "idle",
  receivedBytes: 0,
  totalBytes: OFFICE_ENGINE_PACKAGE.approxBytes,
  error: null,
};
let running: Promise<void> | null = null;

export async function isOfficeEngineInstalledAt(engineDir: string): Promise<boolean> {
  try {
    const info = await fs.stat(nodePath.join(engineDir, OFFICE_ENGINE_API_SCRIPT));
    return info.isFile();
  } catch {
    return false;
  }
}

export async function getOfficeEngineStatus(engineDir: string): Promise<OfficeEngineStatus> {
  const installed = await isOfficeEngineInstalledAt(engineDir);
  return {
    installed,
    state: installed && status.state !== "installing" ? "installed" : status.state,
    receivedBytes: status.receivedBytes,
    totalBytes: status.totalBytes,
    error: status.error,
  };
}

/** Starts the install unless it is running already. Never rejects. */
export function startOfficeEngineInstall(engineDir: string): void {
  if (running) return;
  status.state = "installing";
  status.receivedBytes = 0;
  status.error = null;
  running = installOfficeEngine(engineDir)
    .then(() => {
      status.state = "installed";
    })
    .catch((error: unknown) => {
      status.state = "error";
      status.error = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      running = null;
    });
}

function runTar(args: ReadonlyArray<string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar failed (${code}): ${stderr.trim()}`)),
    );
  });
}

export async function installOfficeEngine(
  engineDir: string,
  pkg: { readonly url: string; readonly sha256: string } = OFFICE_ENGINE_PACKAGE,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const parent = nodePath.dirname(engineDir);
  await fs.mkdir(parent, { recursive: true });
  const work = await fs.mkdtemp(nodePath.join(parent, ".office-engine-install-"));
  try {
    const archive = nodePath.join(work, "engine.tar.gz");
    const response = await fetchImpl(pkg.url);
    if (!response.ok || !response.body) {
      throw new Error(`Couldn't download Office (HTTP ${response.status}).`);
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > 0) status.totalBytes = length;
    const hash = createHash("sha256");
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        status.receivedBytes += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      meter,
      createWriteStream(archive),
    );
    const digest = hash.digest("hex");
    if (digest !== pkg.sha256) {
      throw new Error("The Office download is corrupted (checksum mismatch). Try again.");
    }
    const unpacked = nodePath.join(work, "unpacked");
    await fs.mkdir(unpacked);
    await runTar(["-xzf", archive, "-C", unpacked, "--no-same-owner"]);
    await fs.rm(archive, { force: true });
    if (!(await isOfficeEngineInstalledAt(unpacked))) {
      throw new Error("The Office package has an unexpected layout.");
    }
    const previous = `${engineDir}.old`;
    await fs.rm(previous, { recursive: true, force: true });
    const hadPrevious = await fs
      .stat(engineDir)
      .then(() => true)
      .catch(() => false);
    if (hadPrevious) await fs.rename(engineDir, previous);
    await fs.rename(unpacked, engineDir);
    await fs.rm(previous, { recursive: true, force: true });
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
