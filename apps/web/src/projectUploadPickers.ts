/**
 * DOM-обвязка загрузки в существующий проект: системные пикеры и разбор
 * drag-and-drop. Чистая логика загрузки — в `projectUpload.ts`.
 */

import type { ProjectUploadFile } from "./projectUpload";

/**
 * Жёсткий потолок обхода перетащенной папки: перетаскивание каталога с
 * node_modules не должно вешать вкладку — лишнее дальше всё равно отсеет план.
 */
const TRAVERSAL_MAX_ENTRIES = 50_000;

function normalizeRelativePath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function uploadFilesFromFileList(fileList: FileList): ProjectUploadFile[] {
  // Для папки из webkitdirectory-пикера webkitRelativePath начинается с имени
  // самой папки — при загрузке в проект она сознательно сохраняется: папка
  // должна лечь подпапкой, а не рассыпаться содержимым по целевой директории.
  return Array.from(fileList).map((file) => ({
    relativePath: normalizeRelativePath(file.webkitRelativePath || file.name),
    size: file.size,
    blob: file,
  }));
}

function pickWithInput(setup: (input: HTMLInputElement) => void, onPicked: (files: FileList) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  setup(input);
  input.style.display = "none";
  input.onchange = () => {
    const files = input.files;
    input.remove();
    if (files && files.length > 0) {
      onPicked(files);
    }
  };
  document.body.appendChild(input);
  input.click();
}

/**
 * Пикер отдельных файлов (любых). Как и pickFolderForUpload, обязан вызываться
 * из обработчика пользовательского жеста; отмена пикера не сообщается.
 */
export function pickFilesForProjectUpload(onPicked: (files: ProjectUploadFile[]) => void): void {
  pickWithInput(
    (input) => {
      input.multiple = true;
    },
    (files) => onPicked(uploadFilesFromFileList(files)),
  );
}

/** Пикер каталога (webkitdirectory). */
export function pickFolderForProjectUpload(onPicked: (files: ProjectUploadFile[]) => void): void {
  pickWithInput(
    (input) => {
      input.multiple = true;
      input.setAttribute("webkitdirectory", "");
    },
    (files) => onPicked(uploadFilesFromFileList(files)),
  );
}

interface FileSystemEntryLike {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly fullPath: string;
  file?: (resolve: (file: File) => void, reject: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      resolve: (entries: FileSystemEntryLike[]) => void,
      reject: (error: unknown) => void,
    ) => void;
  };
}

async function collectEntry(entry: FileSystemEntryLike, out: ProjectUploadFile[]): Promise<void> {
  if (out.length >= TRAVERSAL_MAX_ENTRIES) return;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File | null>((resolve) => {
      entry.file!(resolve, () => resolve(null));
    });
    if (file) {
      out.push({
        relativePath: normalizeRelativePath(entry.fullPath),
        size: file.size,
        blob: file,
      });
    }
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries отдаёт содержимое порциями (Chrome — по 100) и требует
    // повторных вызовов до пустого ответа.
    for (;;) {
      const batch = await new Promise<FileSystemEntryLike[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (batch.length === 0) return;
      for (const child of batch) {
        await collectEntry(child, out);
        if (out.length >= TRAVERSAL_MAX_ENTRIES) return;
      }
    }
  }
}

/**
 * Разбирает DataTransfer дропа: файлы и папки (рекурсивно). Если браузер не
 * даёт webkitGetAsEntry — плоский fallback на dataTransfer.files (без папок).
 */
export async function readDroppedUploadFiles(
  dataTransfer: DataTransfer,
): Promise<ProjectUploadFile[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .filter((item) => item.kind === "file")
    .map((item) =>
      typeof item.webkitGetAsEntry === "function"
        ? (item.webkitGetAsEntry() as FileSystemEntryLike | null)
        : null,
    );

  if (entries.length === 0 || entries.some((entry) => entry === null)) {
    return uploadFilesFromFileList(dataTransfer.files);
  }

  const out: ProjectUploadFile[] = [];
  for (const entry of entries) {
    await collectEntry(entry!, out);
  }
  return out;
}
