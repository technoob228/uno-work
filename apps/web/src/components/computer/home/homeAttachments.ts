/**
 * What is attached on Home's composer (a screenshot pasted, a file dropped,
 * the paperclip). It rides along to the new chat, so the first message carries
 * it exactly as if it had been attached in the chat itself: pictures through
 * the chat's draft, other files (pdf, docx, zip…) through the file handoff —
 * they land in ~/Uploads/YYYY-MM on the chat's computer when it is sent.
 */
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

import { chatFileRejection, composerFileFromFile, routeComposerFiles } from "../../../chatUploads";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../../composerDraftStore";
import { randomUUID } from "~/lib/utils";

export interface HomeAttachmentsResult {
  readonly images: ComposerImageAttachment[];
  readonly files: ComposerFileAttachment[];
  /** The last problem met (too big, too many); null = all taken. */
  readonly error: string | null;
}

/** Sorts `files` into pictures and other files, up to the per-message limit. */
export function homeAttachmentsFromFiles(
  files: ReadonlyArray<File>,
  alreadyAttached: number,
  makePreviewUrl: (file: File) => string = (file) => URL.createObjectURL(file),
): HomeAttachmentsResult {
  // Home has no model-specific video pipeline: a video is just a file here.
  const routed = routeComposerFiles(files, { isVideo: () => false, imagesSupported: true });
  const images: ComposerImageAttachment[] = [];
  const plain: ComposerFileAttachment[] = [];
  let count = alreadyAttached;
  let error: string | null = null;
  for (const file of files) {
    if (count >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `Up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`;
      break;
    }
    if (routed.images.includes(file)) {
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
      continue;
    }
    const rejection = chatFileRejection(file);
    if (rejection) {
      error = rejection;
      continue;
    }
    plain.push(composerFileFromFile(file));
    count += 1;
  }
  return { images, files: plain, error };
}
