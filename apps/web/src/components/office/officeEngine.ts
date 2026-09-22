/**
 * Тонкая обёртка над ONLYOFFICE DocsAPI из офлайн-пакета движка, который демон
 * раздаёт по `/office-engine/` (см. apps/server/src/officeEngine.ts).
 *
 * Как это работает без Document Server:
 *   - файл отдаём редактору как blob:-URL; пакет движка сам конвертирует его в
 *     свой формат через x2t (WebAssembly) прямо во вкладке;
 *   - при сохранении зовём `downloadAs(ext)`: движок конвертирует обратно и
 *     вызывает внутри своего iframe `AscCommon.DownloadFileFromBytes` — мы его
 *     перехватываем и забираем байты вместо скачивания.
 *
 * Движок всегда грузится с origin самой страницы Work: iframe редактора тогда
 * same-origin, и перехват работает независимо от того, с какой машины файл.
 */
import type { OfficeDocumentType } from "./officeFormats";

export const OFFICE_ENGINE_BASE = "/office-engine/";
export const OFFICE_ENGINE_API_PATH = "vendor/web-apps/apps/api/documents/api.js";

type DownloadFn = (data: ArrayBuffer | Uint8Array, fileName: string, mime?: string) => void;

interface DocEditorInstance {
  downloadAs: (format?: string) => void;
  destroyEditor: () => void;
}

interface DocsApi {
  DocEditor: new (placeholderId: string, config: Record<string, unknown>) => DocEditorInstance;
}

declare global {
  interface Window {
    DocsAPI?: DocsApi;
  }
}

let apiPromise: Promise<DocsApi> | null = null;

export function officeEngineApiUrl(): string {
  return `${OFFICE_ENGINE_BASE}${OFFICE_ENGINE_API_PATH}`;
}

/** Установлен ли пакет движка на этой машине (демон отдаёт api.js). */
export async function isOfficeEngineInstalled(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(officeEngineApiUrl(), { method: "HEAD", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

export function loadDocsApi(): Promise<DocsApi> {
  if (window.DocsAPI) return Promise.resolve(window.DocsAPI);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<DocsApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = officeEngineApiUrl();
    script.async = true;
    script.addEventListener("load", () => {
      if (window.DocsAPI) resolve(window.DocsAPI);
      else reject(new Error("Офисный движок загрузился, но не отдал DocsAPI"));
    });
    script.addEventListener("error", () => {
      apiPromise = null;
      script.remove();
      reject(new Error("Не удалось загрузить офисный движок"));
    });
    document.head.appendChild(script);
  });
  return apiPromise;
}

export interface OfficeEditorOptions {
  container: HTMLElement;
  bytes: Uint8Array;
  fileName: string;
  /** Расширение исходного файла (для открытия). */
  fileType: string;
  documentType: OfficeDocumentType;
  lang?: string;
  userName?: string;
  readOnly?: boolean;
  onReady?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onError?: (message: string) => void;
  /** Пользователь нажал Ctrl/Cmd+S или «Сохранить» внутри редактора. */
  onSaveRequest?: () => void;
}

export interface OfficeEditorHandle {
  /** Конвертирует текущий документ в `format` и возвращает байты файла. */
  exportBytes: (format: string) => Promise<Uint8Array>;
  destroy: () => void;
}

const EXPORT_TIMEOUT_MS = 120_000;
let editorSeq = 0;

export async function createOfficeEditor(
  options: OfficeEditorOptions,
): Promise<OfficeEditorHandle> {
  const api = await loadDocsApi();
  const mountId = `uno-office-editor-${++editorSeq}`;
  const mount = document.createElement("div");
  mount.id = mountId;
  mount.style.width = "100%";
  mount.style.height = "100%";
  options.container.replaceChildren(mount);

  const blobUrl = URL.createObjectURL(new Blob([options.bytes as BlobPart]));
  let pendingExport: {
    resolve: (bytes: Uint8Array) => void;
    reject: (error: Error) => void;
  } | null = null;
  let hookedWindow: Window | null = null;
  let exportChain: Promise<unknown> = Promise.resolve();
  let destroyed = false;

  const frameWindow = ():
    | (Window & { AscCommon?: { DownloadFileFromBytes?: DownloadFn } })
    | null => {
    const frame = options.container.querySelector("iframe");
    try {
      return (
        (frame?.contentWindow as Window & { AscCommon?: { DownloadFileFromBytes?: DownloadFn } }) ??
        null
      );
    } catch {
      return null;
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      options.onSaveRequest?.();
    }
  };

  /** Вешает перехват внутри iframe редактора; идемпотентно. */
  const hookFrame = (): boolean => {
    const win = frameWindow();
    const common = win?.AscCommon;
    if (!win || !common || typeof common.DownloadFileFromBytes !== "function") return false;
    if (hookedWindow === win) return true;
    const original = common.DownloadFileFromBytes;
    common.DownloadFileFromBytes = function (data, fileName, mime) {
      if (pendingExport) {
        const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
        const done = pendingExport;
        pendingExport = null;
        done.resolve(bytes);
        return;
      }
      // Обычное «Скачать как…» из меню редактора — пусть скачивается.
      original.call(common, data, fileName, mime);
    };
    win.addEventListener("keydown", onKeyDown, true);
    hookedWindow = win;
    return true;
  };

  const hookTimer = window.setInterval(() => {
    if (hookFrame() || destroyed) window.clearInterval(hookTimer);
  }, 250);
  window.addEventListener("keydown", onKeyDown, true);

  const editor = new api.DocEditor(mountId, {
    documentType: options.documentType,
    width: "100%",
    height: "100%",
    type: "desktop",
    document: {
      url: blobUrl,
      title: options.fileName,
      fileType: options.fileType,
      key: `uno-${Date.now()}-${editorSeq}`,
      permissions: { edit: !options.readOnly, download: true, print: true, comment: true },
    },
    editorConfig: {
      mode: options.readOnly ? "view" : "edit",
      lang: options.lang ?? "en",
      user: { id: "uno-user", name: options.userName ?? "Uno" },
      customization: {
        // Автосохранение в офлайн-движке — это скачивание; сохраняем сами.
        autosave: false,
        forcesave: false,
        compactHeader: true,
        hideRightMenu: false,
        uiTheme: "theme-light",
        features: { featuresTips: false },
      },
    },
    events: {
      onAppReady: () => options.onReady?.(),
      onDocumentReady: () => {
        hookFrame();
      },
      onDocumentStateChange: (event: { data?: boolean }) =>
        options.onDirtyChange?.(Boolean(event?.data)),
      onError: (event: { data?: { errorDescription?: string } }) =>
        options.onError?.(event?.data?.errorDescription ?? "Ошибка офисного движка"),
      onRequestSaveAs: () => options.onSaveRequest?.(),
    },
  });

  const runExport = (format: string) =>
    new Promise<Uint8Array>((resolve, reject) => {
      if (destroyed) {
        reject(new Error("Редактор закрыт"));
        return;
      }
      if (!hookFrame()) {
        reject(new Error("Редактор ещё не готов"));
        return;
      }
      const timer = window.setTimeout(() => {
        pendingExport = null;
        reject(new Error("Движок не отдал файл за 2 минуты"));
      }, EXPORT_TIMEOUT_MS);
      pendingExport = {
        resolve: (bytes) => {
          window.clearTimeout(timer);
          resolve(bytes);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      };
      try {
        editor.downloadAs(format);
      } catch (error) {
        window.clearTimeout(timer);
        pendingExport = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

  return {
    exportBytes(format) {
      const result = exportChain.then(
        () => runExport(format),
        () => runExport(format),
      );
      exportChain = result.catch(() => undefined);
      return result;
    },
    destroy() {
      destroyed = true;
      window.clearInterval(hookTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      hookedWindow?.removeEventListener("keydown", onKeyDown, true);
      pendingExport?.reject(new Error("Редактор закрыт"));
      pendingExport = null;
      try {
        editor.destroyEditor();
      } catch {
        /* движок уже снят */
      }
      URL.revokeObjectURL(blobUrl);
      options.container.replaceChildren();
    },
  };
}
