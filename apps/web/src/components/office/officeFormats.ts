/**
 * Какие файлы открывает офисный движок и каким редактором. Это же — точка
 * подключения для Files: `isOfficeFile(path)` → «Open in Office» → `/office?path=…`.
 */

export type OfficeDocumentType = "word" | "cell" | "slide";

const WORD = new Set(["docx", "doc", "odt", "rtf", "dotx"]);
const CELL = new Set(["xlsx", "xls", "ods", "xltx", "xlsm"]);
const SLIDE = new Set(["pptx", "ppt", "odp", "potx", "ppsx"]);

/** Форматы, которые движок умеет и открыть, и записать обратно без смены формата. */
const ROUND_TRIP = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp", "rtf"]);

export function officeExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function officeDocumentType(path: string): OfficeDocumentType | null {
  const ext = officeExtension(path);
  if (WORD.has(ext)) return "word";
  if (CELL.has(ext)) return "cell";
  if (SLIDE.has(ext)) return "slide";
  return null;
}

export function isOfficeFile(path: string): boolean {
  return officeDocumentType(path) !== null;
}

/**
 * Формат, в который сохраняем. Старые бинарные (doc/xls/ppt) движок читает, но
 * пишет только в OOXML — такие файлы сохраняем рядом как .docx/.xlsx/.pptx,
 * исходник не трогаем.
 */
export function officeSaveTarget(path: string): { extension: string; path: string } | null {
  const ext = officeExtension(path);
  const type = officeDocumentType(path);
  if (!type) return null;
  if (ROUND_TRIP.has(ext)) return { extension: ext, path };
  const ooxml = type === "word" ? "docx" : type === "cell" ? "xlsx" : "pptx";
  const base = ext ? path.slice(0, -(ext.length + 1)) : path;
  return { extension: ooxml, path: `${base}.${ooxml}` };
}

export function officeFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Маршрут редактора для файла машины — его зовёт Files. */
export function officeRouteSearch(path: string): { path: string } {
  return { path };
}
