/**
 * Non-image files attached to a chat message (pdf, docx, xlsx, zip…).
 *
 * The composer holds the picked `File`s; on send their bytes are staged on the
 * chat's computer at `~/Uploads/.incoming/<uploadId>` (chunked
 * `projects.writeFile`, the same path a Files upload takes) and the turn
 * carries `{ type: "file", uploadId, … }`. The server moves each one to
 * `~/Uploads/YYYY-MM/<name>` and tells the model where it is.
 */
import {
  CHAT_UPLOAD_INCOMING_FOLDER,
  CHAT_UPLOADS_FOLDER,
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_INLINE_IMAGE_TOTAL_BYTES,
  PROVIDER_SEND_TURN_MAX_INLINE_IMAGES,
  type UploadChatFileAttachment,
} from "@t3tools/contracts";

import type { ComposerFileAttachment } from "./composerDraftStore";
import { ensureEnvironmentApi } from "./environmentApi";
import { resolveHomeFolder } from "./hooks/useFolderChats";
import { randomUUID } from "./lib/utils";
import { uploadFilesIntoDirectory } from "./projectUpload";

export const CHAT_FILE_SIZE_LIMIT_LABEL = `${Math.round(
  PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024 * 1024),
)} GB`;

/** The composer's attachment for a picked non-image file. */
export function composerFileFromFile(file: File): ComposerFileAttachment {
  return {
    type: "file",
    id: randomUUID(),
    name: file.name || "file",
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

export interface RoutedComposerFiles<T> {
  /** Pictures the model sees inline (and that are also saved to Uploads). */
  readonly images: T[];
  readonly videos: T[];
  /** Everything else, saved to Uploads and opened by the model from disk. */
  readonly files: T[];
}

/**
 * Sorts what was dropped/pasted/picked: pictures within the inline limits go
 * as images (when the model can see them), videos as videos, and anything
 * else — a PDF, a sheet, a zip, a picture too big to inline or past what one
 * message carries inline — as a file.
 */
export function routeComposerFiles<T extends { readonly type: string; readonly size: number }>(
  files: ReadonlyArray<T>,
  options: {
    readonly isVideo: (file: T) => boolean;
    readonly imagesSupported: boolean;
    /** Pictures already on the message: they count against the inline limits. */
    readonly inlineImages?: { readonly count: number; readonly bytes: number };
  },
): RoutedComposerFiles<T> {
  const images: T[] = [];
  const videos: T[] = [];
  const plain: T[] = [];
  let inlineCount = options.inlineImages?.count ?? 0;
  let inlineBytes = options.inlineImages?.bytes ?? 0;
  for (const file of files) {
    if (
      options.imagesSupported &&
      file.type.startsWith("image/") &&
      file.size <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES &&
      inlineCount < PROVIDER_SEND_TURN_MAX_INLINE_IMAGES &&
      inlineBytes + file.size <= PROVIDER_SEND_TURN_MAX_INLINE_IMAGE_TOTAL_BYTES
    ) {
      images.push(file);
      inlineCount += 1;
      inlineBytes += file.size;
    } else if (options.isVideo(file)) {
      videos.push(file);
    } else {
      plain.push(file);
    }
  }
  return { images, videos, files: plain };
}

/** Why `file` can't be attached as a plain file, or null when it can. */
export function chatFileRejection(file: { name: string; size: number }): string | null {
  if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    return `'${file.name}' is over the ${CHAT_FILE_SIZE_LIMIT_LABEL} limit.`;
  }
  return null;
}

/** `/home/me/Uploads/2026-10/a.pdf` → `Uploads/2026-10/a.pdf` (what Files shows). */
export function displayUploadPath(path: string): string {
  const marker = `/${CHAT_UPLOADS_FOLDER}/`;
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf(marker);
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** Where a staged upload goes, relative to the home (`~`). */
export function chatUploadIncomingRelativePath(uploadId: string): string {
  return `${CHAT_UPLOAD_INCOMING_FOLDER}/${uploadId}`;
}

/**
 * Stage `attachment`'s bytes on the chat's computer and return what the turn
 * carries for it.
 */
export async function stageChatFileUpload(
  environmentId: EnvironmentId,
  attachment: ComposerFileAttachment,
  options: { readonly signal?: AbortSignal } = {},
): Promise<UploadChatFileAttachment> {
  const api = ensureEnvironmentApi(environmentId);
  const uploadId = randomUUID();
  const result = await uploadFilesIntoDirectory(
    { writeFile: (write) => api.projects.writeFile(write) },
    {
      targetDir: "~",
      files: [
        {
          relativePath: chatUploadIncomingRelativePath(uploadId),
          size: attachment.sizeBytes,
          blob: attachment.file,
        },
      ],
      filterIgnored: false,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (result.uploadedFiles !== 1) {
    throw new Error(`Couldn't upload '${attachment.name}'.`);
  }
  return {
    type: "file",
    uploadId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}

/** `Uploads/2026-10/1a2b3c-photo.png`: the short id keeps same-named files apart. */
export function chatUploadSavedRelativePath(name: string, now: Date, id: string): string {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const safeName = name.replace(/[/\\]/g, "_") || "file";
  return `${CHAT_UPLOADS_FOLDER}/${month}/${id.slice(0, 6)}-${safeName}`;
}

/**
 * Save files on the chat's computer right away (a turn's files go through the
 * server when the message is sent; an answer to the agent's question has no
 * such step) and return where they are, for the agent to open.
 */
export async function saveFilesToUploads(
  environmentId: EnvironmentId,
  files: ReadonlyArray<File>,
): Promise<string[]> {
  const api = ensureEnvironmentApi(environmentId);
  const now = new Date();
  const saved = files.map((file) => ({
    file,
    relativePath: chatUploadSavedRelativePath(file.name, now, randomUUID()),
  }));
  const result = await uploadFilesIntoDirectory(
    { writeFile: (write) => api.projects.writeFile(write) },
    {
      targetDir: "~",
      files: saved.map(({ file, relativePath }) => ({
        relativePath,
        size: file.size,
        blob: file,
      })),
      filterIgnored: false,
    },
  );
  if (result.uploadedFiles !== files.length) {
    throw new Error("Some files didn't upload. Try again.");
  }
  const home = await resolveHomeFolder(environmentId);
  return saved.map(({ relativePath }) => `${home ?? "~"}/${relativePath}`);
}
