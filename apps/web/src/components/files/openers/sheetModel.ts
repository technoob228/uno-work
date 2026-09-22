/**
 * Spreadsheet model behind the Files table viewer/editor.
 *
 * Excel files are edited *in place*: the original workbook is parsed once, the
 * editor records only the cells the person changed, and saving writes those
 * cells back into that same workbook. Formulas, other sheets, merges and
 * column widths in untouched places survive. What SheetJS (community build)
 * can't write back — fonts, colours, charts, pictures — is detected up front
 * so the UI can save to a copy instead of silently dropping it.
 */
import JSZip from "jszip";
import * as XLSX from "xlsx";

import { evaluateFormula } from "./formulaEval";
import {
  parseDelimitedRows,
  serializeDelimitedRows,
  spreadsheetColumnLabel,
} from "../../preview/previewFileUtils";

export const SHEET_VIEW_MAX_ROWS = 2000;
export const SHEET_VIEW_MAX_COLS = 100;

export interface SheetCell {
  /** What the cell shows (formatted value, or the formula when nothing is cached). */
  readonly display: string;
  /** What editing starts from: `=FORMULA` for formula cells, else the raw value. */
  readonly input: string;
}

export interface SheetData {
  readonly name: string;
  /** Rows × columns, padded to a rectangle, capped at the view limits. */
  readonly cells: ReadonlyArray<ReadonlyArray<SheetCell>>;
  readonly totalRows: number;
  readonly totalCols: number;
}

export interface WorkbookData {
  readonly format: "csv" | "tsv" | "xlsx" | "xlsm" | "ods" | "xls" | "other";
  readonly sheets: ReadonlyArray<SheetData>;
  /** Parts SheetJS can't write back (charts, pictures, styling…). */
  readonly unsupportedParts: ReadonlyArray<string>;
  readonly workbook: XLSX.WorkBook | null;
}

export type SheetFormat = WorkbookData["format"];

export function sheetFormatOf(name: string): SheetFormat {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv" || ext === "tsv" || ext === "xlsx" || ext === "xlsm" || ext === "ods") {
    return ext;
  }
  if (ext === "xls") return "xls";
  return "other";
}

/** Formats the browser editor can write back. */
export function isEditableSheetFormat(format: SheetFormat): boolean {
  return format === "csv" || format === "tsv" || format === "xlsx" || format === "xlsm";
}

const EMPTY_CELL: SheetCell = { display: "", input: "" };

function textCell(value: string): SheetCell {
  return { display: value, input: value };
}

function rectangle(
  rows: ReadonlyArray<ReadonlyArray<SheetCell>>,
): ReadonlyArray<ReadonlyArray<SheetCell>> {
  const cols = Math.max(1, ...rows.map((row) => row.length));
  const padded = rows.map((row) =>
    row.length === cols
      ? row
      : [...row, ...Array.from({ length: cols - row.length }, () => EMPTY_CELL)],
  );
  return padded.length > 0 ? padded : [Array.from({ length: cols }, () => EMPTY_CELL)];
}

function parseDelimited(text: string, format: "csv" | "tsv"): WorkbookData {
  const rows = parseDelimitedRows(text, format === "tsv" ? "\t" : ",");
  const totalCols = Math.max(1, ...rows.map((row) => row.length));
  const cells = rectangle(
    rows
      .slice(0, SHEET_VIEW_MAX_ROWS)
      .map((row) => row.slice(0, SHEET_VIEW_MAX_COLS).map(textCell)),
  );
  return {
    format,
    sheets: [{ name: "Sheet1", cells, totalRows: rows.length, totalCols }],
    unsupportedParts: [],
    workbook: null,
  };
}

function cellInput(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  if (cell.f) return `=${cell.f}`;
  if (cell.v === undefined || cell.v === null) return "";
  if (cell.v instanceof Date) return cell.w ?? cell.v.toISOString();
  return String(cell.v);
}

function cellDisplay(sheet: XLSX.WorkSheet, cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  // A formula nobody has calculated yet (edited here, Excel hasn't opened it
  // since): work it out when it's simple, else show the formula itself.
  if (cell.v === undefined || cell.v === null || (cell.f && cell.v === "")) {
    if (!cell.f) return "";
    const computed = evaluateFormula(sheet, cell.f);
    return computed === null ? `=${cell.f}` : String(computed);
  }
  try {
    return XLSX.utils.format_cell(cell);
  } catch {
    return String(cell.v);
  }
}

function sheetFromWorksheet(name: string, sheet: XLSX.WorkSheet): SheetData {
  const ref = sheet["!ref"];
  if (!ref) return { name, cells: rectangle([]), totalRows: 0, totalCols: 0 };
  const range = XLSX.utils.decode_range(ref);
  // Views start at A1 so cell addresses match what Excel shows.
  const totalRows = range.e.r + 1;
  const totalCols = range.e.c + 1;
  const rows: SheetCell[][] = [];
  for (let r = 0; r < Math.min(totalRows, SHEET_VIEW_MAX_ROWS); r += 1) {
    const row: SheetCell[] = [];
    for (let c = 0; c < Math.min(totalCols, SHEET_VIEW_MAX_COLS); c += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      row.push({ display: cellDisplay(sheet, cell), input: cellInput(cell) });
    }
    rows.push(row);
  }
  return { name, cells: rectangle(rows), totalRows, totalCols };
}

/** Zip parts that SheetJS community edition drops when it writes a workbook. */
export function detectUnsupportedParts(fileNames: ReadonlyArray<string>): string[] {
  const found = new Set<string>();
  for (const name of fileNames) {
    if (name.startsWith("xl/charts/")) found.add("charts");
    else if (name.startsWith("xl/drawings/") || name.startsWith("xl/media/")) found.add("pictures");
    else if (name.startsWith("xl/pivotTables/")) found.add("pivot tables");
    else if (name.startsWith("xl/tables/")) found.add("formatted tables");
  }
  return [...found];
}

export async function parseWorkbook(
  name: string,
  bytes: ArrayBuffer,
  listZipEntries?: (bytes: ArrayBuffer) => Promise<string[]>,
): Promise<WorkbookData> {
  const format = sheetFormatOf(name);
  if (format === "csv" || format === "tsv") {
    return parseDelimited(new TextDecoder("utf-8").decode(bytes), format);
  }
  const workbook = XLSX.read(new Uint8Array(bytes), {
    type: "array",
    cellFormula: true,
    cellDates: true,
    cellNF: true,
    cellStyles: true,
  });
  const sheets = workbook.SheetNames.flatMap((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    return sheet ? [sheetFromWorksheet(sheetName, sheet)] : [];
  });
  let unsupportedParts: string[] = [];
  if ((format === "xlsx" || format === "xlsm") && listZipEntries) {
    try {
      unsupportedParts = detectUnsupportedParts(await listZipEntries(bytes));
    } catch {
      unsupportedParts = [];
    }
  }
  // Any styled cell (fills, fonts, borders) is formatting the browser can't keep.
  const styled = Object.values(workbook.Sheets).some((sheet) =>
    Object.entries(sheet).some(
      ([key, cell]) =>
        !key.startsWith("!") &&
        typeof cell === "object" &&
        cell !== null &&
        "s" in cell &&
        hasVisibleStyle((cell as { s?: unknown }).s),
    ),
  );
  if (styled) unsupportedParts = [...unsupportedParts, "cell colours and fonts"];
  return { format, sheets, unsupportedParts, workbook };
}

function hasVisibleStyle(style: unknown): boolean {
  if (!style || typeof style !== "object") return false;
  const record = style as Record<string, unknown>;
  const fill = record["fgColor"] as { rgb?: string } | undefined;
  if (record["patternType"] && record["patternType"] !== "none") return true;
  if (fill?.rgb && fill.rgb !== "FFFFFF" && fill.rgb !== "FFFFFFFF") return true;
  return false;
}

// ── Edits ──────────────────────────────────────────────────────────────────

/** `sheetIndex:row:col` → new input text (`=…` for a formula). */
export type SheetEdits = ReadonlyMap<string, string>;

export function editKey(sheetIndex: number, row: number, col: number): string {
  return `${sheetIndex}:${row}:${col}`;
}

function parseEditKey(key: string): { sheet: number; row: number; col: number } {
  const [sheet, row, col] = key.split(":").map(Number);
  return { sheet: sheet!, row: row!, col: col! };
}

function coerce(input: string): XLSX.CellObject | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // SheetJS drops a formula that has no cached value, so it gets an empty
  // one; `markFullCalcOnLoad` makes Excel/LibreOffice compute it on open.
  if (trimmed.startsWith("=") && trimmed.length > 1) return { t: "s", v: "", f: trimmed.slice(1) };
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return { t: "n", v: numeric };
  }
  if (/^(true|false)$/i.test(trimmed)) return { t: "b", v: trimmed.toLowerCase() === "true" };
  return { t: "s", v: input };
}

/** Apply edits to the workbook in place and return the file bytes. */
export function writeWorkbookWithEdits(
  data: WorkbookData,
  edits: SheetEdits,
  appended: {
    readonly rows: ReadonlyMap<number, number>;
    readonly cols: ReadonlyMap<number, number>;
  },
): Uint8Array {
  if (data.format === "csv" || data.format === "tsv") {
    const sheet = data.sheets[0];
    const rowCount = (sheet?.cells.length ?? 0) + (appended.rows.get(0) ?? 0);
    const colCount = (sheet?.cells[0]?.length ?? 0) + (appended.cols.get(0) ?? 0);
    const rows: string[][] = [];
    for (let r = 0; r < rowCount; r += 1) {
      const row: string[] = [];
      for (let c = 0; c < colCount; c += 1) {
        const edited = edits.get(editKey(0, r, c));
        row.push(edited ?? sheet?.cells[r]?.[c]?.input ?? "");
      }
      rows.push(row);
    }
    // Drop fully empty trailing rows the editor added but never filled.
    while (rows.length > 1 && rows.at(-1)!.every((cell) => cell === "")) rows.pop();
    const text = serializeDelimitedRows(rows, data.format === "tsv" ? "\t" : ",");
    return new TextEncoder().encode(text);
  }

  const workbook = data.workbook;
  if (!workbook) throw new Error("This spreadsheet can't be saved from the browser.");
  for (const [key, input] of edits) {
    const { sheet: sheetIndex, row, col } = parseEditKey(key);
    const sheetName = workbook.SheetNames[sheetIndex];
    const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!sheet) continue;
    const address = XLSX.utils.encode_cell({ r: row, c: col });
    const next = coerce(input);
    const previous = sheet[address] as XLSX.CellObject | undefined;
    if (next === null) {
      delete sheet[address];
    } else {
      // Keep the cell's number format / style reference when it had one.
      sheet[address] = {
        ...next,
        ...(previous?.z ? { z: previous.z } : {}),
        ...(previous?.s ? { s: previous.s } : {}),
      };
    }
    const range = sheet["!ref"]
      ? XLSX.utils.decode_range(sheet["!ref"])
      : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    range.e.r = Math.max(range.e.r, row);
    range.e.c = Math.max(range.e.c, col);
    sheet["!ref"] = XLSX.utils.encode_range(range);
  }
  // The browser can't recalculate: every formula's cached result may now be
  // stale, so drop them — the grid shows the formula, Excel/LibreOffice
  // compute it on open (see markFullCalcOnLoad).
  if (edits.size > 0) {
    for (const sheet of Object.values(workbook.Sheets)) {
      for (const [address, cell] of Object.entries(sheet)) {
        if (address.startsWith("!") || !cell || typeof cell !== "object") continue;
        const formulaCell = cell as XLSX.CellObject;
        if (formulaCell.f) {
          sheet[address] = { ...formulaCell, t: "s", v: "", w: "" } as XLSX.CellObject;
        }
      }
    }
  }
  const bookType: XLSX.BookType = data.format === "xlsm" ? "xlsm" : "xlsx";
  const out = XLSX.write(workbook, { type: "array", bookType, compression: true }) as ArrayBuffer;
  return new Uint8Array(out);
}

/**
 * Ask Excel and LibreOffice to recalculate every formula when the file opens:
 * cached results of cells that depend on edited ones are stale otherwise.
 */
export async function markFullCalcOnLoad(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const part = zip.file("xl/workbook.xml");
  if (!part) return bytes;
  let xml = await part.async("text");
  if (/<calcPr\b[^>]*fullCalcOnLoad=/.test(xml)) return bytes;
  if (/<calcPr\b/.test(xml)) {
    xml = xml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  } else if (xml.includes("</definedNames>")) {
    xml = xml.replace("</definedNames>", '</definedNames><calcPr fullCalcOnLoad="1"/>');
  } else if (xml.includes("</sheets>")) {
    xml = xml.replace("</sheets>", '</sheets><calcPr fullCalcOnLoad="1"/>');
  } else {
    return bytes;
  }
  zip.file("xl/workbook.xml", xml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export function cellAddress(row: number, col: number): string {
  return `${spreadsheetColumnLabel(col)}${row + 1}`;
}
