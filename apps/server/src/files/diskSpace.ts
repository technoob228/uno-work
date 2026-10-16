/**
 * "Will this fit?" before writing a lot onto the computer's disk (copies from
 * the cloud): a full disk breaks apps, installs and the computer itself, so a
 * download that would leave less than {@link reserveBytes} free is refused
 * before the first byte lands (small ones only need to fit).
 *
 * @module files/diskSpace
 */
import fsPromises, { statfs } from "node:fs/promises";
import nodePath from "node:path";

import { FilesPathError } from "./filesPaths.ts";
import { formatBytes } from "./sharePages.ts";

/** Always left free: at least 1 GB… */
export const DISK_RESERVE_MIN_BYTES = 1024 ** 3;
/** …or 5% of the disk when that is more. */
export const DISK_RESERVE_FRACTION = 0.05;
/** A copy this small may dip into the reserve, as long as it fits at all. */
export const DISK_SMALL_COPY_BYTES = 50 * 1024 * 1024;

export interface DiskSpace {
  /** Bytes this process may still write on the volume. */
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** `path`, or its nearest parent that exists (a folder a copy will create). */
async function nearestExisting(path: string): Promise<string> {
  let current = nodePath.resolve(path);
  const exists = (candidate: string) => fsPromises.stat(candidate).then(Boolean, () => false);
  while (!(await exists(current))) {
    const parent = nodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/** The volume that will hold `path` (its nearest existing parent); null when unknown. */
export async function diskSpaceAt(path: string): Promise<DiskSpace | null> {
  try {
    const stats = await statfs(await nearestExisting(path));
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return null;
  }
}

/** What must stay free on a disk of `totalBytes`. */
export function reserveBytes(totalBytes: number): number {
  return Math.max(DISK_RESERVE_MIN_BYTES, Math.round(totalBytes * DISK_RESERVE_FRACTION));
}

/**
 * True when writing `needBytes` still leaves the reserve free — or, for a
 * small copy (under {@link DISK_SMALL_COPY_BYTES}), when it fits at all: a
 * low disk shouldn't block opening one document.
 */
export function fitsOnDisk(needBytes: number, space: DiskSpace): boolean {
  const need = Math.max(0, needBytes);
  if (need < DISK_SMALL_COPY_BYTES) return need <= space.freeBytes;
  return space.freeBytes - need >= reserveBytes(space.totalBytes);
}

/** A refusal that names the sizes; `message` is safe to show. */
export class NotEnoughSpaceError extends FilesPathError {
  readonly needBytes: number;
  readonly freeBytes: number;
  constructor(needBytes: number, freeBytes: number) {
    super(
      "forbidden",
      `Not enough space on this computer: needs ${formatBytes(needBytes)}, ${formatBytes(freeBytes)} free. Free up space or pick fewer files.`,
    );
    this.name = "NotEnoughSpaceError";
    this.needBytes = needBytes;
    this.freeBytes = freeBytes;
  }
}

/**
 * Throws {@link NotEnoughSpaceError} when `needBytes` written under `path`
 * would eat into the reserve. A volume we can't measure is let through.
 */
export async function ensureDiskSpace(
  path: string,
  needBytes: number,
  measure: (path: string) => Promise<DiskSpace | null> = diskSpaceAt,
): Promise<void> {
  const space = await measure(path);
  if (space && !fitsOnDisk(needBytes, space)) {
    throw new NotEnoughSpaceError(needBytes, space.freeBytes);
  }
}

/** The same refusal worded for an agent, which has a tool to free space. */
export function agentDiskSpaceMessage(message: string): string {
  return message.startsWith("Not enough space on this computer:")
    ? message.replace(
        "Free up space or pick fewer files.",
        "Free space with computer_cleanup or pick fewer files.",
      )
    : message;
}
