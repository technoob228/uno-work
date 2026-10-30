/**
 * A big attachment takes minutes to reach the chat's computer, and the
 * composer has nothing to show for it: a toast with the bytes says it's going.
 */
import type { EnvironmentId, UploadChatFileAttachment } from "@t3tools/contracts";

import { stageChatFileUpload } from "./chatUploads";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import type { ComposerFileAttachment } from "./composerDraftStore";
import { formatUploadBytes } from "./projectUpload";

/** Smaller files are there before a toast could be read. */
export const CHAT_UPLOAD_TOAST_MIN_BYTES = 50 * 1024 * 1024;
const PROGRESS_UPDATE_INTERVAL_MS = 400;

export function stageChatFileWithToast(
  environmentId: EnvironmentId,
  attachment: ComposerFileAttachment,
): Promise<UploadChatFileAttachment> {
  if (attachment.sizeBytes < CHAT_UPLOAD_TOAST_MIN_BYTES) {
    return stageChatFileUpload(environmentId, attachment);
  }
  const toastId = toastManager.add(
    stackedThreadToast({
      type: "loading",
      title: `Uploading ${attachment.name}…`,
      description: formatUploadBytes(attachment.sizeBytes),
      timeout: 0,
    }),
  );
  let lastUpdateAt = 0;
  const staged = stageChatFileUpload(environmentId, attachment, {
    onProgress: (progress) => {
      const now = Date.now();
      if (now - lastUpdateAt < PROGRESS_UPDATE_INTERVAL_MS) return;
      lastUpdateAt = now;
      toastManager.update(toastId, {
        description: `${formatUploadBytes(progress.sentBytes)} of ${formatUploadBytes(progress.totalBytes)}`,
      });
    },
  });
  const close = () => toastManager.close(toastId);
  void staged.then(close, close);
  return staged;
}
