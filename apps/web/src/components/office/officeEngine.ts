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
import {
  attachDocsShell,
  installDocsShellStyle,
  type DocsEngineWindow,
  type DocsShell,
} from "./officeDocsShell";

export const OFFICE_ENGINE_BASE = "/office-engine/";

export type OfficeAccess = "view" | "comment" | "edit";

/**
 * DocsAPI config for an access level. "comment" is the engine's own
 * comment-only mode: edit mode with editing off and commenting on.
 *
 * Macros and plugins are always off: ONLYOFFICE macros are JavaScript stored
 * inside the document and would run on this page's origin — the same origin
 * as the owner's Work session — so a document edited by someone else could
 * act as the owner.
 */
export function officeAccessConfig(access: OfficeAccess): {
  mode: "view" | "edit";
  permissions: Record<string, boolean>;
} {
  return {
    mode: access === "view" ? "view" : "edit",
    permissions: {
      edit: access === "edit",
      comment: access !== "view",
      review: false,
      download: true,
      print: true,
      copy: true,
      modifyFilter: access === "edit",
      modifyContentControl: access === "edit",
      fillForms: access === "edit",
    },
  };
}
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
    // An SPA fallback (desktop t3:// protocol, dev server) answers 200 with
    // index.html for any path — only a real script counts.
    const type = response.headers.get("content-type") ?? "";
    return response.ok && type.includes("javascript");
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
  /** Stable per person, so comments keep their author. */
  userId?: string;
  readOnly?: boolean;
  /**
   * What the person may do, like Google Docs' Viewer/Commenter/Editor.
   * Defaults to "edit" (or "view" when `readOnly`).
   */
  access?: OfficeAccess;
  onReady?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onError?: (message: string) => void;
  /** Пользователь нажал Ctrl/Cmd+S или «Сохранить» внутри редактора. */
  onSaveRequest?: () => void;
  /**
   * Our own toolbar instead of the engine's ribbon (Word only, see
   * officeDocsShell.ts). `onShell` gets it once the document is open.
   */
  docsShell?: boolean;
  onShell?: (shell: DocsShell) => void;
}

export interface OfficeEditorHandle {
  /** Конвертирует текущий документ в `format` и возвращает байты файла. */
  exportBytes: (format: string) => Promise<Uint8Array>;
  /**
   * Tell the engine the document is saved, so the next edit fires
   * `onDirtyChange(true)` again (offline, the engine never clears it itself).
   */
  markSaved: () => void;
  /**
   * "Download as…": converts through the same export queue as saving (so a
   * PDF can never be taken for the bytes of an autosave) and hands the file
   * to the browser.
   */
  downloadAs: (format: string, fileName: string) => Promise<void>;
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
  let shell: DocsShell | null = null;

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

  /** Hide the ribbon as soon as the iframe has a document, before it paints. */
  const styleFrame = (): boolean => {
    if (!options.docsShell) return true;
    try {
      const doc = frameWindow()?.document;
      // The iframe starts on about:blank; style the editor's own document.
      if (!doc || !doc.location.href.includes(OFFICE_ENGINE_BASE)) return false;
      return installDocsShellStyle(doc);
    } catch {
      return false;
    }
  };
  const attachShell = () => {
    if (!options.docsShell || shell || destroyed) return;
    const win = frameWindow();
    if (!win) return;
    shell = attachDocsShell(win as unknown as DocsEngineWindow);
    if (shell) options.onShell?.(shell);
  };

  let styled = false;
  const hookTimer = window.setInterval(() => {
    if (!styled) styled = styleFrame();
    if ((hookFrame() && styled) || destroyed) window.clearInterval(hookTimer);
  }, 50);
  window.addEventListener("keydown", onKeyDown, true);

  const access: OfficeAccess = options.access ?? (options.readOnly ? "view" : "edit");
  const accessConfig = officeAccessConfig(access);
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
      permissions: accessConfig.permissions,
    },
    editorConfig: {
      mode: accessConfig.mode,
      lang: options.lang ?? "en",
      user: { id: options.userId ?? "uno-user", name: options.userName ?? "Uno" },
      customization: {
        // Автосохранение в офлайн-движке — это скачивание; сохраняем сами.
        autosave: false,
        forcesave: false,
        compactHeader: true,
        hideRightMenu: false,
        uiTheme: "theme-light",
        features: { featuresTips: false },
        macros: false,
        macrosMode: "disable",
        plugins: false,
      },
    },
    events: {
      onAppReady: () => options.onReady?.(),
      onDocumentReady: () => {
        hookFrame();
        attachShell();
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

  const exportBytes = (format: string) => {
    const result = exportChain.then(
      () => runExport(format),
      () => runExport(format),
    );
    exportChain = result.catch(() => undefined);
    return result;
  };

  return {
    markSaved() {
      const win = frameWindow() as
        | (Window & {
            editor?: { SetDocumentModified?: (value: boolean) => void };
            Asc?: { editor?: { SetDocumentModified?: (value: boolean) => void } };
          })
        | null;
      try {
        (win?.editor ?? win?.Asc?.editor)?.SetDocumentModified?.(false);
      } catch {
        /* older engine: autosave just waits for the next explicit save */
      }
    },
    async downloadAs(format, fileName) {
      const bytes = await exportBytes(format);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
    exportBytes,
    destroy() {
      destroyed = true;
      window.clearInterval(hookTimer);
      shell?.detach();
      shell = null;
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
