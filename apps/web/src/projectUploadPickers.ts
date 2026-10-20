/**
 * DOM-обвязка загрузки в существующий проект: системные пикеры и разбор
 * drag-and-drop. Чистая логика загрузки — в `projectUpload.ts`.
 */

import { VENV_MARKER_FILE, ignoredFolderLabel, isIgnoredUploadFolderName } from "./firstProject";
import { type DroppedItemShape, type ProjectUploadFile, isFolderOrZipDrop } from "./projectUpload";

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

function pickWithInput(
  setup: (input: HTMLInputElement) => void,
  onPicked: (files: FileList) => void,
): void {
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

/** What reading a folder found, and what it chose not to open. */
export interface ReadFolder {
  readonly files: ProjectUploadFile[];
  /** Heavy folders skipped without opening ("node_modules", "Python environments"). */
  readonly unopenedFolders: ReadonlyArray<string>;
  /** The reader stopped at its own ceiling: there is more than `files`. */
  readonly truncated: boolean;
  /** The folder itself (File System Access), kept to resume after a reload. */
  readonly handle?: FileSystemDirectoryHandleLike;
}

interface ReadState {
  readonly out: ProjectUploadFile[];
  readonly unopened: Set<string>;
  truncated: boolean;
  lastTick: number;
  readonly onCount?: ((filesFound: number) => void) | undefined;
}

function tick(state: ReadState): void {
  const now = Date.now();
  if (state.onCount && now - state.lastTick > 100) {
    state.lastTick = now;
    state.onCount(state.out.length);
  }
}

async function collectEntry(entry: FileSystemEntryLike, state: ReadState): Promise<void> {
  if (state.out.length >= TRAVERSAL_MAX_ENTRIES) {
    state.truncated = true;
    return;
  }
  if (entry.isFile && entry.file) {
    const file = await new Promise<File | null>((resolve) => {
      entry.file!(resolve, () => resolve(null));
    });
    if (file) {
      state.out.push({
        relativePath: normalizeRelativePath(entry.fullPath),
        size: file.size,
        blob: file,
      });
      tick(state);
    }
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const name = entry.fullPath.split("/").filter(Boolean).at(-1) ?? "";
    // A folder that is a dropped root keeps its name even if it looks heavy.
    const depth = entry.fullPath.split("/").filter(Boolean).length;
    if (depth > 1 && isIgnoredUploadFolderName(name)) {
      state.unopened.add(ignoredFolderLabel(name));
      return;
    }
    const reader = entry.createReader();
    // readEntries отдаёт содержимое порциями (Chrome — по 100) и требует
    // повторных вызовов до пустого ответа.
    const children: FileSystemEntryLike[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntryLike[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (batch.length === 0) break;
      children.push(...batch);
    }
    if (
      depth > 1 &&
      children.some((child) => child.isFile && child.fullPath.endsWith(`/${VENV_MARKER_FILE}`))
    ) {
      state.unopened.add("Python environments");
      return;
    }
    for (const child of children) {
      await collectEntry(child, state);
      if (state.out.length >= TRAVERSAL_MAX_ENTRIES) {
        state.truncated = true;
        return;
      }
    }
  }
}

/**
 * Разбирает DataTransfer дропа: файлы и папки (рекурсивно), не заходя в
 * тяжёлые папки (node_modules, .git, venv…) — они всё равно не едут. Если
 * браузер не даёт webkitGetAsEntry — плоский fallback на dataTransfer.files
 * (без папок).
 */
export async function readDroppedFolder(
  dataTransfer: DataTransfer,
  onCount?: (filesFound: number) => void,
): Promise<ReadFolder> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .filter((item) => item.kind === "file")
    .map((item) =>
      typeof item.webkitGetAsEntry === "function"
        ? (item.webkitGetAsEntry() as FileSystemEntryLike | null)
        : null,
    );

  if (entries.length === 0 || entries.some((entry) => entry === null)) {
    return {
      files: uploadFilesFromFileList(dataTransfer.files),
      unopenedFolders: [],
      truncated: false,
    };
  }

  const state: ReadState = {
    out: [],
    unopened: new Set(),
    truncated: false,
    lastTick: 0,
    onCount,
  };
  for (const entry of entries) {
    await collectEntry(entry!, state);
  }
  return { files: state.out, unopenedFolders: [...state.unopened], truncated: state.truncated };
}

export async function readDroppedUploadFiles(
  dataTransfer: DataTransfer,
): Promise<ProjectUploadFile[]> {
  return (await readDroppedFolder(dataTransfer)).files;
}

// ── Choose a folder: File System Access first, the classic picker otherwise ──

/** The bits of `FileSystemDirectoryHandle` used here (not in every TS DOM lib). */
export interface FileSystemDirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<FileSystemHandleLike>;
  queryPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
}

type FileSystemHandleLike =
  | FileSystemDirectoryHandleLike
  | { readonly kind: "file"; readonly name: string; getFile(): Promise<File> };

type ShowDirectoryPicker = (options?: {
  mode?: "read";
  id?: string;
}) => Promise<FileSystemDirectoryHandleLike>;

/** Set once the direct way failed here: the next click uses the classic picker. */
let directReadFailed = false;

/** The direct way failed for another reason than Cancel: try the classic picker. */
export class FolderPickerRetryError extends Error {
  constructor() {
    super("Couldn't open the folder that way. Click Choose a folder… again.");
    this.name = "FolderPickerRetryError";
  }
}

/** The browser can hand over a folder without reading all of it first. */
export function canReadFolderDirectly(): boolean {
  if (typeof window === "undefined" || directReadFailed) return false;
  if (typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker !== "function") {
    return false;
  }
  // Not allowed in cross-origin frames.
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

/**
 * Walks a picked folder, skipping heavy folders by name without opening them
 * and telling the live count as it goes. Paths start with the folder's own
 * name, like `webkitRelativePath`.
 */
export async function readDirectoryHandle(
  root: FileSystemDirectoryHandleLike,
  onCount?: (filesFound: number) => void,
): Promise<ReadFolder> {
  const state: ReadState = {
    out: [],
    unopened: new Set(),
    truncated: false,
    lastTick: 0,
    onCount,
  };
  const walk = async (dir: FileSystemDirectoryHandleLike, prefix: string, depth: number) => {
    const children: FileSystemHandleLike[] = [];
    for await (const child of dir.values()) children.push(child);
    if (
      depth > 0 &&
      children.some((child) => child.kind === "file" && child.name === VENV_MARKER_FILE)
    ) {
      state.unopened.add("Python environments");
      return;
    }
    const files = children.filter((child) => child.kind === "file");
    // getFile() is a round trip to the browser's file thread: a folder's files side by side.
    const picked = await Promise.all(
      files.map((child) =>
        (child as Extract<FileSystemHandleLike, { kind: "file" }>)
          .getFile()
          .then((file) => ({ name: child.name, file }))
          .catch(() => null),
      ),
    );
    for (const entry of picked) {
      if (!entry) continue;
      state.out.push({
        relativePath: `${prefix}/${entry.name}`,
        size: entry.file.size,
        blob: entry.file,
      });
    }
    tick(state);
    for (const child of children) {
      if (child.kind !== "directory") continue;
      if (isIgnoredUploadFolderName(child.name)) {
        state.unopened.add(ignoredFolderLabel(child.name));
        continue;
      }
      await walk(child, `${prefix}/${child.name}`, depth + 1);
    }
  };
  await walk(root, root.name, 0);
  onCount?.(state.out.length);
  return { files: state.out, unopenedFolders: [...state.unopened], truncated: false, handle: root };
}

export interface ChooseFolderHooks {
  /** The picker closed and the browser is reading the folder (classic picker: no count). */
  readonly onReading?: (filesFound: number | null) => void;
}

/**
 * "Choose a folder…": with File System Access the folder is read here — heavy
 * folders never opened, a live count — and the browser asks one short
 * question ("Let this site view files?"). Without it, the classic picker: the
 * browser reads everything (node_modules too) and then asks "Upload N files to
 * this site?" — we can only say it is reading. Resolves null when cancelled.
 * Call from a click handler.
 */
export async function chooseFolderForProjectUpload(
  hooks: ChooseFolderHooks = {},
): Promise<ReadFolder | null> {
  if (canReadFolderDirectly()) {
    let root: FileSystemDirectoryHandleLike;
    try {
      root = await (
        window as unknown as { showDirectoryPicker: ShowDirectoryPicker }
      ).showDirectoryPicker({ mode: "read", id: "uno-project-upload" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      // A picker needs a fresh click: the classic one can't open from here.
      directReadFailed = true;
      throw new FolderPickerRetryError();
    }
    hooks.onReading?.(0);
    return readDirectoryHandle(root, (found) => hooks.onReading?.(found));
  }
  return new Promise<ReadFolder | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.style.display = "none";
    // The picker is closed once the window has focus again; Chrome now reads
    // the whole folder (seconds for a big one) before its own confirmation.
    const onFocus = () => hooks.onReading?.(null);
    window.addEventListener("focus", onFocus, { once: true });
    const done = (result: ReadFolder | null) => {
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(result);
    };
    input.addEventListener("cancel", () => done(null));
    input.addEventListener("change", () => {
      const files = input.files;
      done(
        files && files.length > 0
          ? { files: uploadFilesFromFileList(files), unopenedFolders: [], truncated: false }
          : null,
      );
    });
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Was a folder or a .zip dropped? Reads the DataTransfer — call it
 * synchronously in the drop handler (the items are gone after it returns).
 */
export function dataTransferHasFolderOrZip(dataTransfer: DataTransfer): boolean {
  const shapes: DroppedItemShape[] = [];
  for (const item of Array.from(dataTransfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry =
      typeof item.webkitGetAsEntry === "function"
        ? (item.webkitGetAsEntry() as { isDirectory: boolean; name: string } | null)
        : null;
    shapes.push({
      isDirectory: entry?.isDirectory === true,
      name: entry?.name ?? item.getAsFile()?.name ?? "",
    });
  }
  if (shapes.length === 0) {
    for (const file of Array.from(dataTransfer.files ?? [])) {
      shapes.push({ isDirectory: false, name: file.name });
    }
  }
  return isFolderOrZipDrop(shapes);
}
