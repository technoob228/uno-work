/**
 * Office documents that live in Cloud storage (`/office?bucket=<id>&key=<key>`).
 *
 * The daemon does the cloud side (files.cloud.officeOpen / officeSave): it
 * downloads the object into a hidden staging folder in the home, and on save
 * checks that nobody saved a newer version in between, keeps the current one
 * under `<folder>/.versions/<name>/` and uploads the new bytes. The page
 * only moves bytes to and from that staging folder with the usual calls.
 */
import { FILESYSTEM_READ_FILE_HARD_MAX_BYTES, type EnvironmentApi } from "@t3tools/contracts";

import { base64ToBytes } from "./officeBytes";
import { writeOfficeBytes } from "./officeSave";

export interface OfficeCloudRef {
  readonly bucketId: number;
  readonly key: string;
}

export interface OfficeCloudOpened {
  readonly bytes: Uint8Array;
  readonly version: string;
  readonly writable: boolean;
  /** The staging folder the daemon uses for this computer (for saves). */
  readonly stagingDir: string;
}

export type OfficeCloudSaveResult =
  | { readonly kind: "saved"; readonly version: string }
  | { readonly kind: "conflict"; readonly version: string | null };

export function cloudDocumentName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/** The folder of a key inside its bucket ("" or ending in "/"). */
export function cloudDocumentFolder(key: string): string {
  return key.slice(0, key.lastIndexOf("/") + 1);
}

function parentDir(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), 1));
}

export async function openCloudDocument(
  api: EnvironmentApi,
  ref: OfficeCloudRef,
): Promise<OfficeCloudOpened> {
  const opened = await api.files.cloudOfficeOpen(ref);
  try {
    const result = await api.filesystem.readFile({
      path: opened.stagedPath,
      maxBytes: FILESYSTEM_READ_FILE_HARD_MAX_BYTES,
    });
    if (result.truncated) {
      throw new Error("This document is too large to open here. Download it instead.");
    }
    const bytes =
      result.encoding === "base64"
        ? base64ToBytes(result.content)
        : new TextEncoder().encode(result.content);
    return {
      bytes,
      version: opened.version,
      writable: opened.writable,
      // <home>/.uno-office-cloud/<random>/<name> → <home>/.uno-office-cloud
      stagingDir: parentDir(parentDir(opened.stagedPath)),
    };
  } finally {
    await api.files.delete({ paths: [parentDir(opened.stagedPath)] }).catch(() => undefined);
  }
}

export async function saveCloudDocument(input: {
  readonly api: EnvironmentApi;
  readonly ref: OfficeCloudRef;
  readonly bytes: Uint8Array;
  readonly baseVersion: string | null;
  readonly stagingDir: string;
  readonly force?: boolean;
}): Promise<OfficeCloudSaveResult> {
  const random = Math.random().toString(36).slice(2, 10);
  const staged = `${input.stagingDir}/save-${random}-${cloudDocumentName(input.ref.key)}`;
  await writeOfficeBytes((write) => input.api.projects.writeFile(write), staged, input.bytes);
  const result = await input.api.files.cloudOfficeSave({
    bucketId: input.ref.bucketId,
    key: input.ref.key,
    stagedPath: staged,
    baseVersion: input.baseVersion,
    ...(input.force ? { force: true } : {}),
  });
  if (result.kind === "saved") return { kind: "saved", version: result.version ?? "" };
  return { kind: "conflict", version: result.version };
}

/** `/office` search params for a Cloud document. */
export function officeCloudSearch(ref: OfficeCloudRef): { bucket: number; key: string } {
  return { bucket: ref.bucketId, key: ref.key };
}
