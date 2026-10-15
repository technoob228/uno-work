/**
 * Chat uploads — whatever a person attaches to a chat is kept for them.
 *
 * Every picture or file attached in the app lands in a visible folder of the
 * computer the chat runs on, `~/Uploads/YYYY-MM/<name>` (`~` = the Files root,
 * so it shows up in the Files section), and the turn tells the model where it
 * is. Pictures still go to the model inline; other files never do — the model
 * opens them from disk with its own tools.
 *
 * Names are kept as the person had them; a taken name becomes `name (2).ext`
 * and nothing is ever overwritten (exclusive create / hard link, not a
 * check-then-write). Any kind of file may come (a script, an installer…):
 * none is ever run, and every one is left `0644` — readable, never
 * executable, whatever mode the staged copy had.
 *
 * @module files/chatUploads
 */
import { constants as fsConstants } from "node:fs";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import {
  CHAT_UPLOAD_INCOMING_FOLDER,
  CHAT_UPLOADS_FOLDER,
  type ChatAttachment,
} from "@t3tools/contracts";

import { numberedName } from "./filesPaths.ts";

const NAME_MAX_BYTES = 200;
const EXTENSION_MAX_CHARS = 16;
const MAX_NAME_ATTEMPTS = 10_000;
/** rw-r--r--: an attachment is a document, never a program to run. */
export const CHAT_UPLOAD_FILE_MODE = 0o644;
/** Staged uploads nobody sent are dropped after this long. */
export const CHAT_UPLOAD_INCOMING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** `2026-10` — the month folder, in the computer's local time. */
export function uploadsMonthFolderName(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** `<root>/Uploads/2026-10`. */
export function uploadsMonthDir(filesRoot: string, now: Date): string {
  return nodePath.join(filesRoot, CHAT_UPLOADS_FOLDER, uploadsMonthFolderName(now));
}

/** Where the composer staged an upload (`<home>/Uploads/.incoming/<id>`). */
export function incomingUploadPath(homeDir: string, uploadId: string): string {
  return nodePath.join(homeDir, ...CHAT_UPLOAD_INCOMING_FOLDER.split("/"), uploadId);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let out = "";
  for (const char of value) {
    if (Buffer.byteLength(out + char, "utf8") > maxBytes) break;
    out += char;
  }
  return out;
}

/**
 * A file name safe to create inside the uploads folder, as close to the
 * original as possible: only the last path segment, no separators or control
 * characters, not hidden (no leading dot), at most 200 bytes with the
 * extension kept. Empty → `fallback`.
 */
export function safeUploadFileName(name: string, fallback = "file"): string {
  const lastSegment = name.split(/[/\\]/).pop() ?? "";
  const cleaned = lastSegment
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return fallback;
  if (Buffer.byteLength(cleaned, "utf8") <= NAME_MAX_BYTES) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension =
    dot > 0 && cleaned.length - dot <= EXTENSION_MAX_CHARS ? cleaned.slice(dot) : "";
  const base = cleaned.slice(0, cleaned.length - extension.length);
  const keptBase = truncateUtf8(base, NAME_MAX_BYTES - Buffer.byteLength(extension, "utf8"));
  return `${keptBase.trimEnd()}${extension}` || fallback;
}

function candidateName(name: string, attempt: number): string {
  return attempt === 1 ? name : numberedName(name, attempt);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Write `bytes` as a new file in `<root>/Uploads/YYYY-MM/`. Returns its
 * absolute path. Never overwrites: a taken name gets " (2)", " (3)", …
 */
export async function saveBytesToUploads(input: {
  readonly filesRoot: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly now?: Date;
}): Promise<string> {
  const directory = uploadsMonthDir(input.filesRoot, input.now ?? new Date());
  await fsPromises.mkdir(directory, { recursive: true });
  const name = safeUploadFileName(input.name);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const target = nodePath.join(directory, candidateName(name, attempt));
    try {
      await fsPromises.writeFile(target, input.bytes, { flag: "wx", mode: CHAT_UPLOAD_FILE_MODE });
      // The umask may only take bits away; chmod pins exactly 0644.
      await fsPromises.chmod(target, CHAT_UPLOAD_FILE_MODE);
      return target;
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;
      throw error;
    }
  }
  throw new Error(`No free name for '${name}' in ${directory}.`);
}

/** Put `sourcePath` at `target` unless `target` exists (then EEXIST). */
async function placeExclusive(sourcePath: string, target: string): Promise<void> {
  try {
    // link(2) fails with EEXIST instead of replacing: no overwrite race.
    await fsPromises.link(sourcePath, target);
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw error;
    // No hard links here (another volume, some network/FUSE mounts): copy
    // with COPYFILE_EXCL, which also refuses to replace.
    await fsPromises.copyFile(sourcePath, target, fsConstants.COPYFILE_EXCL);
  }
  await fsPromises.rm(sourcePath, { force: true });
}

/**
 * Move a staged upload to `<root>/Uploads/YYYY-MM/<name>` (never overwrites).
 * Returns the new absolute path.
 */
export async function moveIntoUploads(input: {
  readonly filesRoot: string;
  readonly sourcePath: string;
  readonly name: string;
  readonly now?: Date;
}): Promise<string> {
  const directory = uploadsMonthDir(input.filesRoot, input.now ?? new Date());
  await fsPromises.mkdir(directory, { recursive: true });
  const name = safeUploadFileName(input.name);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const target = nodePath.join(directory, candidateName(name, attempt));
    try {
      await placeExclusive(input.sourcePath, target);
      // The staged copy came through projects.writeFile with whatever mode it
      // got there: never leave an attachment executable.
      await fsPromises.chmod(target, CHAT_UPLOAD_FILE_MODE);
      return target;
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;
      throw error;
    }
  }
  throw new Error(`No free name for '${name}' in ${directory}.`);
}

/** Best effort: drop staged uploads older than `maxAgeMs` (sends that never happened). */
export async function pruneStaleIncomingUploads(
  homeDir: string,
  options: { readonly maxAgeMs?: number; readonly nowMs?: number } = {},
): Promise<number> {
  const directory = nodePath.join(homeDir, ...CHAT_UPLOAD_INCOMING_FOLDER.split("/"));
  const maxAgeMs = options.maxAgeMs ?? CHAT_UPLOAD_INCOMING_MAX_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  let removed = 0;
  let entries: string[];
  try {
    entries = await fsPromises.readdir(directory);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = nodePath.join(directory, entry);
    try {
      const stat = await fsPromises.lstat(target);
      if (stat.isFile() && nowMs - stat.mtimeMs > maxAgeMs) {
        await fsPromises.rm(target, { force: true });
        removed += 1;
      }
    } catch {
      // Gone already or unreadable: not ours to fight over.
    }
  }
  return removed;
}

function noteName(name: string): string {
  return name.replace(/[\r\n]+/g, " ").replace(/"/g, "'");
}

/**
 * The line the model gets for each attachment of a turn, telling it where the
 * file is on this computer. Video digests are left out (their context block
 * already describes them). `storedImagePath` resolves where an image without
 * a saved copy (connector pictures, older messages) is kept internally.
 */
export function buildChatAttachmentsNote(
  attachments: ReadonlyArray<ChatAttachment>,
  options: { readonly storedImagePath?: (attachmentId: string) => string | null } = {},
): string | null {
  const lines: string[] = [];
  for (const attachment of attachments) {
    switch (attachment.type) {
      case "file":
        lines.push(
          `[Attached file "${noteName(attachment.name)}" saved at ${attachment.path} — open it from there whenever you need it again.]`,
        );
        break;
      case "image": {
        if (attachment.savedPath) {
          lines.push(
            `[Attached image "${noteName(attachment.name)}" saved at ${attachment.savedPath} — open it from there whenever you need it again.]`,
          );
          break;
        }
        const stored = options.storedImagePath?.(attachment.id) ?? null;
        if (stored) {
          lines.push(
            `[Attached image "${noteName(attachment.name)}" is also on disk at ${stored}.]`,
          );
        }
        break;
      }
      case "video_digest":
        break;
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/** `text` followed by the attachment note (a blank line between). */
export function appendChatAttachmentsNote(text: string, note: string | null): string {
  if (!note) return text;
  return text.trim().length > 0 ? `${text}\n\n${note}` : note;
}
