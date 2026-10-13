/**
 * Pictures attached on Home's composer (a screenshot pasted, a file dropped,
 * the paperclip). They ride along to the new chat's draft, so the first message
 * carries them exactly as if they had been attached in the chat itself.
 */
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import type { ComposerImageAttachment } from "../../../composerDraftStore";
import { randomUUID } from "~/lib/utils";

const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;

export interface HomeImagesResult {
  readonly images: ComposerImageAttachment[];
  /** The last problem met (a wrong type, too big, too many); null = all taken. */
  readonly error: string | null;
}

/** Picks the pictures out of `files`, up to the per-message limit. */
export function homeImagesFromFiles(
  files: ReadonlyArray<File>,
  alreadyAttached: number,
  makePreviewUrl: (file: File) => string = (file) => URL.createObjectURL(file),
): HomeImagesResult {
  const images: ComposerImageAttachment[] = [];
  let count = alreadyAttached;
  let error: string | null = null;
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      error = `'${file.name}' can't be attached here — only pictures for now.`;
      continue;
    }
    if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = `'${file.name}' is over the ${IMAGE_SIZE_LIMIT_LABEL} limit.`;
      continue;
    }
    if (count >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `Up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} pictures per message.`;
      break;
    }
    images.push({
      type: "image",
      id: randomUUID(),
      name: file.name || "image",
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: makePreviewUrl(file),
      file,
    });
    count += 1;
  }
  return { images, error };
}
