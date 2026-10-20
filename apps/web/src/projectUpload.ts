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

/**
 * Файлов в полёте у загрузки папки. Каждый файл — минимум один запрос по WS
 * с ответом, и на 20 000 мелких файлов последовательная загрузка упирается в
 * задержку сети (20 000 × RTT), а не в канал. Замер 20.10 (1000 файлов,
 * 15 МБ, RTT 200 мс): по одному — ~210 с, 8 — 27.6 с, 16 — 14.5 с. Память:
 * до 16 чанков по ~4 МБ base64 сразу, когда параллельно идут большие файлы.
 */
export const PROJECT_UPLOAD_PARALLEL_FILES = 16;

export interface ProjectUploadFile {
  /** Путь относительно целевой папки, posix-разделители. */
  readonly relativePath: string;
  readonly size: number;
  readonly blob: Blob;
}

export function planProjectUpload(
  files: ReadonlyArray<{ readonly relativePath: string; readonly size: number }>,
  options: {
    readonly filterIgnored: boolean;
    readonly skipFolders?: ReadonlyMap<string, string>;
  },
): UploadPlan {
  const limits: UploadPlanLimits = {
    maxFileBytes: PROJECT_UPLOAD_MAX_FILE_BYTES,
    maxTotalBytes: PROJECT_UPLOAD_MAX_TOTAL_BYTES,
    maxFileCount: PROJECT_UPLOAD_MAX_FILE_COUNT,
    filterIgnored: options.filterIgnored,
    ...(options.skipFolders ? { skipFolders: options.skipFolders } : {}),
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
 * остальные — append. Чанки одного файла идут строго по порядку; разные
 * файлы — по `concurrency` штук сразу (по умолчанию один): на тысячах мелких
 * файлов время уходит на ожидание ответа, а не на канал.
 */
export async function uploadFilesIntoDirectory(
  deps: ProjectUploadDeps,
  input: {
    readonly targetDir: string;
    readonly files: ReadonlyArray<ProjectUploadFile>;
    readonly filterIgnored: boolean;
    /** Folders the person also chose to leave out (see `UploadPlanLimits.skipFolders`). */
    readonly skipFolders?: ReadonlyMap<string, string>;
    readonly onProgress?: (progress: ProjectUploadProgress) => void;
    readonly signal?: AbortSignal;
    /**
     * Files in flight at once (default 1). Chunks of one file always go in
     * order; different files go side by side.
     */
    readonly concurrency?: number;
    /**
     * Already on the computer from an earlier try (resume): not sent again,
     * counted as done.
     */
    readonly alreadyUploaded?: ReadonlySet<string>;
    /** Told after each file is fully written (and put in place). */
    readonly onFileUploaded?: (relativePath: string) => void;
    /**
     * Write each file under another relative path first (e.g. a hidden temp
     * name next to it) and hand it to `onFileWritten` to put in place — so a
     * half-uploaded file never shows up under its real name.
     */
    readonly stagedPathFor?: (relativePath: string) => string;
    readonly onFileWritten?: (file: {
      readonly relativePath: string;
      readonly stagedRelativePath: string;
    }) => Promise<void>;
  },
): Promise<ProjectUploadResult> {
  const readChunkBase64 = deps.readChunkBase64 ?? readFileAsBase64;
  const plan = planProjectUpload(input.files, {
    filterIgnored: input.filterIgnored,
    ...(input.skipFolders ? { skipFolders: input.skipFolders } : {}),
  });
  const byRelativePath = new Map(input.files.map((file) => [file.relativePath, file]));
  const done = input.alreadyUploaded ?? new Set<string>();

  let completedFiles = 0;
  let sentBytes = 0;
  const queue: UploadPlan["accepted"][number][] = [];
  for (const entry of plan.accepted) {
    if (done.has(entry.relativePath)) {
      completedFiles += 1;
      sentBytes += entry.size;
    } else {
      queue.push(entry);
    }
  }
  const report = (currentPath: string | null) => {
    input.onProgress?.({
      completedFiles,
      totalFiles: plan.accepted.length,
      sentBytes,
      totalBytes: plan.totalBytes,
      currentPath,
    });
  };

  // The first failure stops the other workers before their next request.
  const failed = new AbortController();
  const stopped = () => failed.signal.aborted || input.signal?.aborted === true;
  const checkStopped = () => {
    throwIfAborted(input.signal);
    if (failed.signal.aborted) throw new DOMException("Upload stopped.", "AbortError");
  };

  const uploadOne = async (entry: UploadPlan["accepted"][number]) => {
    const file = byRelativePath.get(entry.relativePath);
    if (!file) return;
    report(entry.relativePath);
    const writePath = input.stagedPathFor?.(entry.relativePath) ?? entry.relativePath;

    if (file.size === 0) {
      checkStopped();
      await deps.writeFile({
        cwd: input.targetDir,
        relativePath: writePath,
        contents: "",
        encoding: "base64",
      });
    } else {
      let offset = 0;
      while (offset < file.size) {
        checkStopped();
        const chunk = file.blob.slice(offset, offset + PROJECT_UPLOAD_CHUNK_BYTES);
        const contents = await readChunkBase64(chunk);
        await deps.writeFile({
          cwd: input.targetDir,
          relativePath: writePath,
          contents,
          encoding: "base64",
          ...(offset === 0 ? {} : { mode: "append" as const }),
        });
        offset += chunk.size;
        sentBytes += chunk.size;
        report(entry.relativePath);
      }
    }

    if (input.onFileWritten) {
      await input.onFileWritten({
        relativePath: entry.relativePath,
        stagedRelativePath: writePath,
      });
    }
    completedFiles += 1;
    input.onFileUploaded?.(entry.relativePath);
    report(null);
  };

  let next = 0;
  let firstError: unknown = null;
  const worker = async () => {
    while (next < queue.length && !stopped()) {
      const entry = queue[next++]!;
      try {
        await uploadOne(entry);
      } catch (error) {
        if (firstError === null) firstError = error;
        failed.abort();
        return;
      }
    }
  };
  const workers = Math.max(1, Math.min(input.concurrency ?? 1, queue.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (firstError !== null) throw firstError;
  throwIfAborted(input.signal);

  return { plan, uploadedFiles: completedFiles };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("Upload cancelled.", "AbortError");
  }
}

export function formatUploadBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/** A dropped item, as far as "is it a folder to work in?" goes. */
export interface DroppedItemShape {
  readonly isDirectory: boolean;
  readonly name: string;
}

/**
 * A folder or a .zip among what was dropped on a new chat: it comes in as a
 * folder of its own (Upload a folder…), not as attachments. Images, videos and
 * other loose files stay attachments.
 */
export function isFolderOrZipDrop(items: ReadonlyArray<DroppedItemShape>): boolean {
  return items.some((item) => item.isDirectory || /\.zip$/i.test(item.name));
}
