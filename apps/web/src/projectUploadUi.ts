/**
 * Оркестрация загрузки в проект для UI: прогресс в тосте, итог/ошибка, ключи
 * инвалидации. Сама передача — `uploadFilesIntoDirectory` (projectUpload.ts).
 */

import type { EnvironmentId } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { readEnvironmentApi } from "./environmentApi";
import {
  formatUploadBytes,
  uploadFilesIntoDirectory,
  type ProjectUploadFile,
} from "./projectUpload";

const PROGRESS_UPDATE_INTERVAL_MS = 400;

function skippedSummary(skippedCount: number): string {
  return skippedCount > 0
    ? ` Skipped ${skippedCount} (system folders, too large or over the limit).`
    : "";
}

/**
 * Загружает файлы в папку окружения, показывая прогресс тостом. Возвращает
 * true, если хоть один файл доехал (сигнал «пора обновить листинг»).
 */
export async function runProjectUpload(input: {
  readonly environmentId: EnvironmentId | null;
  readonly targetDir: string;
  readonly files: ReadonlyArray<ProjectUploadFile>;
  readonly filterIgnored: boolean;
}): Promise<boolean> {
  if (input.files.length === 0) return false;
  const api = input.environmentId ? readEnvironmentApi(input.environmentId) : undefined;
  if (!api) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Upload failed",
        description: "Computer not connected.",
      }),
    );
    return false;
  }

  const toastId = toastManager.add(
    stackedThreadToast({
      type: "loading",
      title: "Uploading files…",
      description: `${input.files.length} files selected.`,
      timeout: 0,
    }),
  );
  let lastUpdateAt = 0;

  try {
    const result = await uploadFilesIntoDirectory(
      { writeFile: (write) => api.projects.writeFile(write) },
      {
        targetDir: input.targetDir,
        files: input.files,
        filterIgnored: input.filterIgnored,
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastUpdateAt < PROGRESS_UPDATE_INTERVAL_MS) return;
          lastUpdateAt = now;
          toastManager.update(toastId, {
            description: `${progress.completedFiles} of ${progress.totalFiles} files · ${formatUploadBytes(progress.sentBytes)} of ${formatUploadBytes(progress.totalBytes)}`,
          });
        },
      },
    );
    toastManager.close(toastId);

    if (result.uploadedFiles === 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Nothing to upload",
          description: `All ${result.plan.skipped.length} files were skipped (system folders, too large or over the limit).`,
        }),
      );
      return false;
    }

    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Upload complete",
        description: `${result.uploadedFiles} files (${formatUploadBytes(result.plan.totalBytes)}) to ${input.targetDir}.${skippedSummary(result.plan.skipped.length)}`,
      }),
    );
    return true;
  } catch (error) {
    toastManager.close(toastId);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Upload failed",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}
