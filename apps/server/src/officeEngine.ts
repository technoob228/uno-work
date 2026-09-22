/**
 * Офисный движок (ONLYOFFICE-редакторы, собранные для работы целиком в браузере:
 * web-apps + sdkjs + x2t в WebAssembly). Демон только раздаёт статический
 * пакет движка из `<baseDir>/office-engine`; конвертация и редактирование идут в
 * браузере пользователя, файлы читаются/пишутся существующими RPC
 * (`filesystem.readFile` / `projects.writeFile`). Поэтому на машине движок
 * не занимает RAM — только диск.
 *
 * Пакет — AGPL-3.0 (ONLYOFFICE). Он раздаётся как есть, отдельно от кода Work;
 * см. docs/office-engine.md.
 */
import * as nodePath from "node:path";

export const OFFICE_ENGINE_ROUTE_PREFIX = "/office-engine";

/** Файл, по наличию которого клиент понимает, что движок установлен. */
export const OFFICE_ENGINE_API_SCRIPT = "vendor/web-apps/apps/api/documents/api.js";

/**
 * Превращает путь запроса (`/office-engine/vendor/...`) в абсолютный путь внутри
 * каталога движка. Возвращает null для всего, что пытается выйти за каталог.
 */
export function resolveOfficeEngineFilePath(input: {
  readonly engineDir: string;
  readonly requestPathname: string;
}): string | null {
  const { engineDir, requestPathname } = input;
  if (!requestPathname.startsWith(`${OFFICE_ENGINE_ROUTE_PREFIX}/`)) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(requestPathname.slice(OFFICE_ENGINE_ROUTE_PREFIX.length + 1));
  } catch {
    return null;
  }
  if (relative.length === 0 || relative.includes("\0") || relative.includes("\\")) return null;
  const segments = relative.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    return null;
  }
  const root = nodePath.resolve(engineDir);
  const resolved = nodePath.resolve(root, relative);
  if (!resolved.startsWith(`${root}${nodePath.sep}`)) return null;
  return resolved;
}
