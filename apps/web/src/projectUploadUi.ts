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
    ? ` Пропущено ${skippedCount} (служебные каталоги, слишком большие или вне лимита).`
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
        title: "Загрузка не удалась",
        description: "Окружение не подключено.",
      }),
    );
    return false;
  }

  const toastId = toastManager.add(
    stackedThreadToast({
      type: "loading",
      title: "Загрузка файлов…",
      description: `Выбрано файлов: ${input.files.length}.`,
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
            description: `${progress.completedFiles} из ${progress.totalFiles} файлов · ${formatUploadBytes(progress.sentBytes)} из ${formatUploadBytes(progress.totalBytes)}`,
          });
        },
      },
    );
    toastManager.close(toastId);

    if (result.uploadedFiles === 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Нечего загружать",
          description: `Все ${result.plan.skipped.length} файлов отфильтрованы (служебные каталоги, слишком большие или вне лимита).`,
        }),
      );
      return false;
    }

    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Загрузка завершена",
        description: `${result.uploadedFiles} файлов (${formatUploadBytes(result.plan.totalBytes)}) в ${input.targetDir}.${skippedSummary(result.plan.skipped.length)}`,
      }),
    );
    return true;
  } catch (error) {
    toastManager.close(toastId);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Загрузка не удалась",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}
