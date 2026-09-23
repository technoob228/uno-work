/**
 * Word/Excel/PowerPoint files behind a share link open in the in-browser
 * office editor (`/s/<token>`), and a link with "comment" or "edit" access
 * saves back into that same file. This module is the disk side of that:
 *
 * - which files qualify (`officeShareInfo`);
 * - a content version (`contentVersion`) the editor gets with the bytes and
 *   sends back with a save, so a file that changed on the computer while the
 *   link was open is reported as a conflict instead of silently overwritten;
 * - the save itself (`saveSharedOfficeFile`): one writer per file at a time,
 *   the previous bytes kept under `<baseDir>/share-versions/<shareId>/`, then
 *   a write to a temp file next to the target and an atomic rename.
 *
 * The path always comes from the share row (resolved by `resolveShareTarget`),
 * never from the request, so a token can only ever write its own file.
 *
 * @module files/shareOffice
 */
import { createHash, randomBytes } from "node:crypto";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import { mergeDocxComments } from "./docxComments.ts";

export type OfficeShareDocumentType = "word" | "cell" | "slide";

const WORD = new Set(["docx", "doc", "odt", "rtf", "dotx"]);
const CELL = new Set(["xlsx", "xls", "ods", "xltx", "xlsm"]);
const SLIDE = new Set(["pptx", "ppt", "odp", "potx", "ppsx"]);
/**
 * Formats the engine writes back in the same format. doc/xls/ppt only open
 * read-only by link: saving them would change the format, i.e. make another
 * file, and a link may only ever write its own file.
 */
const WRITABLE = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);

/** 60 MB — the same ceiling the owner's Office screen reads. */
export const SHARE_OFFICE_MAX_BYTES = 60 * 1024 * 1024;
/** Previous versions kept per link. */
export const SHARE_OFFICE_KEEP_VERSIONS = 20;

/**
 * Formats a "Can comment" link can save. The daemon only accepts a comment
 * save after checking that nothing but comments changed (docxComments.ts);
 * that check exists for Word documents only. A comment link to a spreadsheet
 * or presentation opens read-only.
 */
const COMMENTABLE = new Set(["docx"]);

export interface OfficeShareInfo {
  readonly extension: string;
  readonly documentType: OfficeShareDocumentType;
  /** A link to this file may be given edit access. */
  readonly writable: boolean;
  /** A "Can comment" link to this file may save its comments. */
  readonly commentable: boolean;
}

export function officeShareInfo(filePath: string): OfficeShareInfo | null {
  const name = nodePath.basename(filePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const documentType: OfficeShareDocumentType | null = WORD.has(extension)
    ? "word"
    : CELL.has(extension)
      ? "cell"
      : SLIDE.has(extension)
        ? "slide"
        : null;
  if (!documentType) return null;
  return {
    extension,
    documentType,
    writable: WRITABLE.has(extension),
    commentable: COMMENTABLE.has(extension),
  };
}

export type OfficeShareAccess = "view" | "comment" | "edit";

/** What a link may actually do with this file, whatever the owner picked. */
export function effectiveOfficeAccess(
  info: OfficeShareInfo,
  access: OfficeShareAccess,
): OfficeShareAccess {
  if (access === "edit") return info.writable ? "edit" : "view";
  if (access === "comment") return info.commentable ? "comment" : "view";
  return "view";
}

/** Short content hash; changes whenever the bytes do. */
export function contentVersion(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url").slice(0, 22);
}

/**
 * OOXML and ODF files are zip archives. Refusing anything else keeps a
 * broken or hostile upload from replacing a document with junk.
 */
export function looksLikeOfficeArchive(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export type ShareOfficeSaveResult =
  | { readonly kind: "saved"; readonly version: string; readonly modifiedAt: string }
  | { readonly kind: "conflict"; readonly currentVersion: string; readonly modifiedAt: string }
  | {
      readonly kind: "rejected";
      readonly status: number;
      readonly message: string;
      /** `comment_only`: a comment link tried to change more than comments. */
      readonly code?: "comment_only";
    };

const locks = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier task for the same key has finished. */
async function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function versionStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function keepPreviousVersion(input: {
  readonly versionsDir: string;
  readonly shareId: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly now: Date;
}): Promise<void> {
  const dir = nodePath.join(input.versionsDir, input.shareId);
  await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsPromises.writeFile(
    nodePath.join(dir, `${versionStamp(input.now)}--${input.fileName}`),
    input.bytes,
    { mode: 0o600 },
  );
  const entries = (await fsPromises.readdir(dir)).toSorted();
  for (const stale of entries.slice(0, Math.max(0, entries.length - SHARE_OFFICE_KEEP_VERSIONS))) {
    await fsPromises.rm(nodePath.join(dir, stale), { force: true });
  }
}

/**
 * Save `bytes` into `filePath` (the share's own, already-resolved file).
 *
 * `baseVersion` is the version the editor opened; if the file on disk is no
 * longer that version the save is refused as a conflict — unless `force`,
 * which the visitor only sends after being told and choosing to replace.
 */
export async function saveSharedOfficeFile(input: {
  readonly filePath: string;
  readonly shareId: string;
  readonly bytes: Uint8Array;
  readonly baseVersion: string | null;
  readonly force: boolean;
  readonly versionsDir: string;
  /** The link's access; "comment" saves only the comments of `bytes`. */
  readonly access?: OfficeShareAccess;
  readonly now?: Date;
}): Promise<ShareOfficeSaveResult> {
  const info = officeShareInfo(input.filePath);
  if (!info?.writable) {
    return { kind: "rejected", status: 400, message: "This file can't be saved from a link." };
  }
  const access = effectiveOfficeAccess(info, input.access ?? "edit");
  if (access === "view") {
    return {
      kind: "rejected",
      status: 403,
      message:
        input.access === "comment"
          ? "Comments on this kind of file can't be saved through a link yet."
          : "This link can only view the document.",
    };
  }
  if (input.bytes.length === 0 || input.bytes.length > SHARE_OFFICE_MAX_BYTES) {
    return { kind: "rejected", status: 413, message: "The document is too large to save." };
  }
  if (!looksLikeOfficeArchive(input.bytes)) {
    return { kind: "rejected", status: 400, message: "That isn't a document the editor made." };
  }
  if (!input.force && !input.baseVersion) {
    return { kind: "rejected", status: 400, message: "Missing the version the editor opened." };
  }

  return withFileLock(input.filePath, async () => {
    const now = input.now ?? new Date();
    const current = await fsPromises.readFile(input.filePath);
    const stats = await fsPromises.stat(input.filePath);
    const currentVersion = contentVersion(current);
    if (!input.force && currentVersion !== input.baseVersion) {
      return { kind: "conflict", currentVersion, modifiedAt: stats.mtime.toISOString() };
    }
    let bytes = input.bytes;
    if (access === "comment") {
      // Never the visitor's file: the current one with their comments in it.
      const merged = mergeDocxComments({ current, upload: input.bytes });
      if (merged.kind === "rejected") {
        return {
          kind: "rejected",
          status:
            merged.reason === "text_changed" ? 403 : merged.reason === "unsupported" ? 403 : 400,
          message: merged.message,
          ...(merged.reason === "text_changed" ? { code: "comment_only" as const } : {}),
        };
      }
      bytes = merged.bytes;
    }
    const fileName = nodePath.basename(input.filePath);
    await keepPreviousVersion({
      versionsDir: input.versionsDir,
      shareId: input.shareId,
      fileName,
      bytes: current,
      now,
    });
    const temp = nodePath.join(
      nodePath.dirname(input.filePath),
      `.${fileName}.uno-share-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await fsPromises.writeFile(temp, bytes, { mode: stats.mode & 0o777 });
      await fsPromises.rename(temp, input.filePath);
    } catch (error) {
      await fsPromises.rm(temp, { force: true });
      throw error;
    }
    const after = await fsPromises.stat(input.filePath);
    return {
      kind: "saved",
      version: contentVersion(bytes),
      modifiedAt: after.mtime.toISOString(),
    };
  });
}
