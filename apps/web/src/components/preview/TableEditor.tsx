import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as XLSX from "xlsx";

import { cn } from "../../lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { type PreviewFile, usePreviewPane } from "./PreviewPaneContext";
import {
  delimiterForFileName,
  parseDelimitedRows,
  resolveWriteTarget,
  serializeDelimitedRows,
  spreadsheetColumnLabel,
} from "./previewFileUtils";

const EDIT_MAX_ROWS = 1000;
const EDIT_MAX_COLS = 100;

interface EditableSheet {
  name: string;
  rows: string[][];
}

interface ParsedTable {
  sheets: EditableSheet[];
  /** Человекочитаемая причина, по которой редактирование невозможно. */
  error: string | null;
}

function normalizeRows(rows: string[][]): string[][] {
  const cols = Math.max(1, ...rows.map((row) => row.length));
  if (rows.length === 0) return [Array.from({ length: cols }, () => "")];
  return rows.map((row) =>
    row.length === cols ? row : [...row, ...Array.from({ length: cols - row.length }, () => "")],
  );
}

function exceedsEditLimits(sheets: EditableSheet[]): boolean {
  return sheets.some(
    (sheet) => sheet.rows.length > EDIT_MAX_ROWS || (sheet.rows[0]?.length ?? 0) > EDIT_MAX_COLS,
  );
}

function parseCsvTable(content: string, delimiter: string): ParsedTable {
  const rows = normalizeRows(parseDelimitedRows(content, delimiter));
  const sheets = [{ name: "", rows }];
  if (exceedsEditLimits(sheets)) {
    return {
      sheets: [],
      error: `Таблица слишком большая для редактирования (лимит ${EDIT_MAX_ROWS}×${EDIT_MAX_COLS}).`,
    };
  }
  return { sheets, error: null };
}

function spreadsheetEditCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}

function parseXlsxTable(base64: string): ParsedTable {
  try {
    const workbook = XLSX.read(base64, { type: "base64", cellDates: true });
    const sheets = workbook.SheetNames.flatMap((name) => {
      const sheet = workbook.Sheets[name];
      if (!sheet) return [];
      const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: "",
        blankrows: true,
      });
      const rows = normalizeRows(
        rawRows.map((row) => row.map((cell) => spreadsheetEditCellText(cell))),
      );
      return [{ name, rows }];
    });
    if (sheets.length === 0) {
      return { sheets: [{ name: "Sheet1", rows: [[""]] }], error: null };
    }
    if (exceedsEditLimits(sheets)) {
      return {
        sheets: [],
        error: `Таблица слишком большая для редактирования (лимит ${EDIT_MAX_ROWS}×${EDIT_MAX_COLS}).`,
      };
    }
    return { sheets, error: null };
  } catch (error) {
    return {
      sheets: [],
      error: error instanceof Error ? error.message : "Не удалось прочитать Excel-файл",
    };
  }
}

function coerceXlsxCellValue(cell: string): string | number | null {
  if (cell === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(cell.trim())) {
    const numeric = Number(cell.trim());
    if (Number.isFinite(numeric)) return numeric;
  }
  return cell;
}

function serializeXlsx(sheets: EditableSheet[]): string {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet, index) => {
    const aoa = sheet.rows.map((row) => row.map(coerceXlsxCellValue));
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(aoa),
      sheet.name || `Sheet${index + 1}`,
    );
  });
  return XLSX.write(workbook, { type: "base64", bookType: "xlsx" }) as string;
}

function EditPlaceholder({ label, onCancel }: { label: string; onCancel: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-sm text-muted-foreground">{label}</div>
      <Button size="sm" variant="outline" onClick={onCancel}>
        Назад к просмотру
      </Button>
    </div>
  );
}

function GridSheetEditor({
  sheet,
  version,
  onMutateStructure,
}: {
  sheet: EditableSheet;
  version: number;
  onMutateStructure: (mutate: (rows: string[][]) => void) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rows = sheet.rows;
  const cols = rows[0]?.length ?? 1;

  const focusCell = useCallback((row: number, col: number) => {
    const target = containerRef.current?.querySelector<HTMLInputElement>(
      `input[data-cell="${row}:${col}"]`,
    );
    target?.focus();
    target?.select();
  }, []);

  const handleCellKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) {
          focusCell(row - 1, col);
        } else {
          focusCell(row + 1, col);
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusCell(row + 1, col);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusCell(row - 1, col);
      }
    },
    [focusCell],
  );

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-auto">
      <table className="min-w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 h-7 min-w-10 border-b border-r border-border bg-muted px-2 text-muted-foreground" />
            {Array.from({ length: cols }, (_, colIndex) => (
              <th
                key={spreadsheetColumnLabel(colIndex)}
                className="group sticky top-0 z-10 h-7 min-w-24 border-b border-r border-border bg-muted px-2 text-left font-medium text-muted-foreground"
              >
                <span className="flex items-center justify-between gap-1">
                  {spreadsheetColumnLabel(colIndex)}
                  {cols > 1 ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Удалить колонку ${spreadsheetColumnLabel(colIndex)}`}
                      onClick={() =>
                        onMutateStructure((current) => {
                          current.forEach((row) => row.splice(colIndex, 1));
                        })
                      }
                      className="rounded p-0.5 opacity-0 hover:bg-accent hover:text-destructive group-hover:opacity-70"
                    >
                      <Trash2Icon className="size-3" />
                    </button>
                  ) : null}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody key={version}>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="group/row">
              <th className="sticky left-0 z-10 h-7 min-w-10 border-b border-r border-border bg-muted px-1 text-right font-medium text-muted-foreground">
                <span className="flex items-center justify-end gap-0.5">
                  {rows.length > 1 ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Удалить строку ${rowIndex + 1}`}
                      onClick={() =>
                        onMutateStructure((current) => {
                          current.splice(rowIndex, 1);
                        })
                      }
                      className="rounded p-0.5 opacity-0 hover:bg-accent hover:text-destructive group-hover/row:opacity-70"
                    >
                      <Trash2Icon className="size-3" />
                    </button>
                  ) : null}
                  {rowIndex + 1}
                </span>
              </th>
              {row.map((cell, colIndex) => (
                <td
                  key={colIndex}
                  className="min-w-24 border-b border-r border-border p-0 align-top"
                >
                  <input
                    defaultValue={cell}
                    data-cell={`${rowIndex}:${colIndex}`}
                    spellCheck={false}
                    onChange={(event) => {
                      row[colIndex] = event.target.value;
                    }}
                    onKeyDown={(event) => handleCellKeyDown(event, rowIndex, colIndex)}
                    className="h-7 w-full min-w-24 border-0 bg-transparent px-2 text-xs text-foreground outline-none focus:bg-accent/40 focus:ring-1 focus:ring-inset focus:ring-primary/60"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableEditableBody({
  file,
  effectiveEnvironmentId,
}: {
  file: PreviewFile;
  effectiveEnvironmentId: EnvironmentId;
}) {
  const { applyEditedContent, cancelEditing } = usePreviewPane();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [version, setVersion] = useState(0);

  const path = file.path;
  const isXlsx = file.kind === "xlsx";
  const hasInlineContent = !isXlsx && Boolean(file.content);

  const {
    data: loaded,
    isPending,
    isError,
    error,
  } = useQuery({
    queryKey: ["previewReadFile", effectiveEnvironmentId, path],
    queryFn: async () => {
      if (!path) return null;
      const api = readEnvironmentApi(effectiveEnvironmentId);
      if (!api) throw new Error("Окружение недоступно");
      return api.filesystem.readFile({ path });
    },
    enabled: Boolean(path && !hasInlineContent),
    staleTime: 30_000,
  });

  // Снимок данных на момент входа в режим редактирования: правки живут в
  // мутируемых массивах (через ref), чтобы ввод в ячейки не вызывал ререндеры.
  const sheetsRef = useRef<EditableSheet[] | null>(null);
  const initialError = useMemo(() => {
    if (sheetsRef.current) return null;
    if (loaded?.truncated) {
      return "Файл был обрезан при чтении — редактирование запрещено, иначе данные потеряются.";
    }
    let parsed: ParsedTable | null = null;
    if (hasInlineContent) {
      parsed = parseCsvTable(file.content, delimiterForFileName(file.name));
    } else if (loaded) {
      if (isXlsx) {
        parsed =
          loaded.encoding === "base64"
            ? parseXlsxTable(loaded.content)
            : { sheets: [], error: "Не удалось прочитать Excel-файл" };
      } else {
        parsed =
          loaded.encoding === "utf8"
            ? parseCsvTable(loaded.content, delimiterForFileName(file.name))
            : { sheets: [], error: "Файл не является текстовой таблицей" };
      }
    }
    if (!parsed) return null;
    if (parsed.error) return parsed.error;
    sheetsRef.current = parsed.sheets;
    return null;
  }, [file.content, file.name, hasInlineContent, isXlsx, loaded]);

  const mutateStructure = useCallback((mutate: (rows: string[][]) => void) => {
    const sheets = sheetsRef.current;
    if (!sheets) return;
    setActiveSheetIndex((index) => {
      const sheet = sheets[Math.min(index, sheets.length - 1)];
      if (sheet) mutate(sheet.rows);
      return index;
    });
    setVersion((v) => v + 1);
  }, []);

  const handleAddRow = useCallback(() => {
    mutateStructure((rows) => {
      const cols = rows[0]?.length ?? 1;
      rows.push(Array.from({ length: cols }, () => ""));
    });
  }, [mutateStructure]);

  const handleAddColumn = useCallback(() => {
    mutateStructure((rows) => {
      rows.forEach((row) => row.push(""));
    });
  }, [mutateStructure]);

  const handleSave = useCallback(async () => {
    const sheets = sheetsRef.current;
    const target = resolveWriteTarget(file);
    if (!sheets || !path || !target) return;
    setSaving(true);
    try {
      const api = readEnvironmentApi(effectiveEnvironmentId);
      if (!api) throw new Error("Окружение недоступно");
      if (isXlsx) {
        const base64 = serializeXlsx(sheets);
        await api.projects.writeFile({
          cwd: target.cwd,
          relativePath: target.relativePath,
          contents: base64,
          encoding: "base64",
        });
        queryClient.setQueryData(
          ["previewReadFile", effectiveEnvironmentId, path],
          (prev: { encoding: string } | null | undefined) =>
            prev ? { ...prev, content: base64, encoding: "base64" } : prev,
        );
        cancelEditing();
      } else {
        const csv = serializeDelimitedRows(sheets[0]?.rows ?? [], delimiterForFileName(file.name));
        await api.projects.writeFile({
          cwd: target.cwd,
          relativePath: target.relativePath,
          contents: csv,
        });
        queryClient.setQueryData(
          ["previewReadFile", effectiveEnvironmentId, path],
          (prev: { encoding: string } | null | undefined) =>
            prev ? { ...prev, content: csv, encoding: "utf8" } : prev,
        );
        if (hasInlineContent) {
          applyEditedContent(file.id, csv);
        } else {
          cancelEditing();
        }
      }
      toastManager.add({ type: "success", title: "Сохранено", description: file.name });
    } catch (err) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Не удалось сохранить файл",
          description: err instanceof Error ? err.message : "Ошибка",
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [
    applyEditedContent,
    cancelEditing,
    effectiveEnvironmentId,
    file,
    hasInlineContent,
    isXlsx,
    path,
    queryClient,
  ]);

  if (!hasInlineContent && isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2Icon className="mr-2 size-4 animate-spin" />
        Загрузка таблицы...
      </div>
    );
  }
  if (isError) {
    return (
      <EditPlaceholder
        label={error instanceof Error ? error.message : "Не удалось прочитать файл"}
        onCancel={cancelEditing}
      />
    );
  }
  if (initialError) {
    return <EditPlaceholder label={initialError} onCancel={cancelEditing} />;
  }
  const sheets = sheetsRef.current;
  if (!sheets || sheets.length === 0) {
    return <EditPlaceholder label="Нет данных для редактирования" onCancel={cancelEditing} />;
  }

  const activeSheet = sheets[Math.min(activeSheetIndex, sheets.length - 1)]!;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-card px-3 py-2">
        <TooltipProvider delay={300} closeDelay={0}>
          <Button size="sm" variant="outline" onClick={handleAddRow} disabled={saving}>
            <PlusIcon className="size-3.5" />
            Строка
          </Button>
          <Button size="sm" variant="outline" onClick={handleAddColumn} disabled={saving}>
            <PlusIcon className="size-3.5" />
            Колонка
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="ml-1 hidden text-[11px] text-muted-foreground sm:inline">
                  {activeSheet.rows.length}×{activeSheet.rows[0]?.length ?? 0}
                </span>
              }
            />
            <TooltipPopup side="bottom">Строк × колонок</TooltipPopup>
          </Tooltip>
        </TooltipProvider>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={cancelEditing} disabled={saving}>
          Отмена
        </Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
          Сохранить
        </Button>
      </div>
      {isXlsx ? (
        <div className="shrink-0 border-b border-border bg-card px-3 py-1 text-[11px] text-muted-foreground">
          Сохраняются только значения ячеек: формулы и форматирование Excel будут заменены
          результатами.
        </div>
      ) : null}
      {sheets.length > 1 ? (
        <div className="scrollbar-hide flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card px-2 py-1">
          {sheets.map((sheet, index) => (
            <button
              key={`${sheet.name}:${index}`}
              type="button"
              onClick={() => setActiveSheetIndex(index)}
              className={cn(
                "h-7 shrink-0 rounded px-2 text-xs",
                index === activeSheetIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              title={sheet.name}
            >
              <span className="block max-w-32 truncate">{sheet.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <GridSheetEditor
        key={activeSheetIndex}
        sheet={activeSheet}
        version={version}
        onMutateStructure={mutateStructure}
      />
    </div>
  );
}
