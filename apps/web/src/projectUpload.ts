/**
 * Загрузка файлов и папок с компьютера пользователя в уже существующий проект
 * (браузерная версия).
 *
 * Отличается от first-project аплоада (firstProjectRunner) двумя вещами: файлы
 * едут чанками через `projects.writeFile` c `mode: "append"` — большой файл не
 * читается в память целиком и не упирается в размер одного WS-сообщения, — а
 * целевая папка — любая директория проекта, не обязательно его корень.
 */

import { planUpload, type UploadPlan, type UploadPlanLimits } from "./firstProject";
import { readFileAsBase64 } from "./firstProjectFiles";

export const PROJECT_UPLOAD_MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const PROJECT_UPLOAD_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const PROJECT_UPLOAD_MAX_FILE_COUNT = 20_000;

/** Бинарный размер чанка; в base64 он превращается в ~4 МБ на WS-сообщение. */
export const PROJECT_UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;

export interface ProjectUploadFile {
  /** Путь относительно целевой папки, posix-разделители. */
  readonly relativePath: string;
  readonly size: number;
  readonly blob: Blob;
}

export function planProjectUpload(
  files: ReadonlyArray<ProjectUploadFile>,
  options: { readonly filterIgnored: boolean },
): UploadPlan {
  const limits: UploadPlanLimits = {
    maxFileBytes: PROJECT_UPLOAD_MAX_FILE_BYTES,
    maxTotalBytes: PROJECT_UPLOAD_MAX_TOTAL_BYTES,
    maxFileCount: PROJECT_UPLOAD_MAX_FILE_COUNT,
    filterIgnored: options.filterIgnored,
  };
  return planUpload(
    files.map((file) => ({ relativePath: file.relativePath, size: file.size })),
    limits,
  );
}

export interface ProjectUploadWriteInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly encoding?: "utf8" | "base64";
  readonly mode?: "replace" | "append";
}

export interface ProjectUploadDeps {
  readonly writeFile: (input: ProjectUploadWriteInput) => Promise<unknown>;
  /** Подменяется в тестах, чтобы не зависеть от FileReader/arrayBuffer. */
  readonly readChunkBase64?: (chunk: Blob) => Promise<string>;
}

export interface ProjectUploadProgress {
  readonly completedFiles: number;
  readonly totalFiles: number;
  readonly sentBytes: number;
  readonly totalBytes: number;
  readonly currentPath: string | null;
}

export interface ProjectUploadResult {
  readonly plan: UploadPlan;
  readonly uploadedFiles: number;
}

/**
 * Загружает уже отфильтрованные планом файлы в `targetDir`. Первый чанк файла
 * пишется в режиме replace (перезаписывает существующий файл с тем же именем),
 * остальные — append. Файлы идут последовательно: параллельные append по WS
 * ничего не ускорят, а порядок чанков обязан быть строгим.
 */
export async function uploadFilesIntoDirectory(
  deps: ProjectUploadDeps,
  input: {
    readonly targetDir: string;
    readonly files: ReadonlyArray<ProjectUploadFile>;
    readonly filterIgnored: boolean;
    readonly onProgress?: (progress: ProjectUploadProgress) => void;
    readonly signal?: AbortSignal;
  },
): Promise<ProjectUploadResult> {
  const readChunkBase64 = deps.readChunkBase64 ?? readFileAsBase64;
  const plan = planProjectUpload(input.files, { filterIgnored: input.filterIgnored });
  const byRelativePath = new Map(input.files.map((file) => [file.relativePath, file]));

  let completedFiles = 0;
  let sentBytes = 0;
  const report = (currentPath: string | null) => {
    input.onProgress?.({
      completedFiles,
      totalFiles: plan.accepted.length,
      sentBytes,
      totalBytes: plan.totalBytes,
      currentPath,
    });
  };

  for (const entry of plan.accepted) {
    const file = byRelativePath.get(entry.relativePath);
    if (!file) continue;
    report(entry.relativePath);

    if (file.size === 0) {
      throwIfAborted(input.signal);
      await deps.writeFile({
        cwd: input.targetDir,
        relativePath: entry.relativePath,
        contents: "",
        encoding: "base64",
      });
    } else {
      let offset = 0;
      while (offset < file.size) {
        throwIfAborted(input.signal);
        const chunk = file.blob.slice(offset, offset + PROJECT_UPLOAD_CHUNK_BYTES);
        const contents = await readChunkBase64(chunk);
        await deps.writeFile({
          cwd: input.targetDir,
          relativePath: entry.relativePath,
          contents,
          encoding: "base64",
          ...(offset === 0 ? {} : { mode: "append" as const }),
        });
        offset += chunk.size;
        sentBytes += chunk.size;
        report(entry.relativePath);
      }
    }

    completedFiles += 1;
    report(null);
  }

  return { plan, uploadedFiles: completedFiles };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Upload cancelled.", "AbortError");
  }
}

export function formatUploadBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} КБ`;
  }
  return `${bytes} Б`;
}
