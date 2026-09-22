/**
 * CSV and Excel: a real grid to look at, and cell editing that saves back to
 * the same format. See `sheetModel.ts` for what survives a save.
 */
import JSZip from "jszip";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import type { FileEditorProps, FileOpener, FileSource, FileViewProps } from "../fileOpeners";
import { createFile } from "../filesApi";
import { dirname, numberedCopyName } from "../fileTypes";
import { useFileBytes } from "../fileSource";
import { ViewerLoading, ViewerMessage, viewerErrorText } from "./common";
import { SheetGrid } from "./SheetGrid";
import {
  editKey,
  isEditableSheetFormat,
  markFullCalcOnLoad,
  parseWorkbook,
  sheetFormatOf,
  SHEET_VIEW_MAX_COLS,
  SHEET_VIEW_MAX_ROWS,
  type SheetCell,
  type WorkbookData,
  writeWorkbookWithEdits,
} from "./sheetModel";

const SHEET_MAX_BYTES = 30 * 1024 * 1024;

async function listZipEntries(bytes: ArrayBuffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  return Object.keys(zip.files);
}

function useWorkbook(source: FileSource) {
  const bytes = useFileBytes(source);
  const [state, setState] = useState<{ data: WorkbookData | null; error: Error | null }>({
    data: null,
    error: null,
  });
  useEffect(() => {
    if (!bytes.data) return;
    let cancelled = false;
    parseWorkbook(source.name, bytes.data, listZipEntries).then(
      (data) => !cancelled && setState({ data, error: null }),
      (error: unknown) =>
        !cancelled &&
        setState({ data: null, error: error instanceof Error ? error : new Error(String(error)) }),
    );
    return () => {
      cancelled = true;
    };
  }, [bytes.data, source.name]);
  return {
    data: state.data,
    error: bytes.error ?? state.error,
    pending: bytes.isPending || (!state.data && !state.error && !bytes.error),
  };
}

function SheetTabs({
  names,
  active,
  onSelect,
}: {
  names: ReadonlyArray<string>;
  active: number;
  onSelect: (index: number) => void;
}) {
  if (names.length <= 1) return null;
  return (
    <div className="scrollbar-hide flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-card px-2 py-1">
      {names.map((name, index) => (
        <button
          key={`${name}:${index}`}
          type="button"
          onClick={() => onSelect(index)}
          className={cn(
            "h-7 shrink-0 rounded-md px-3 text-xs",
            index === active
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

function truncationNote(data: WorkbookData, sheetIndex: number): string | null {
  const sheet = data.sheets[sheetIndex];
  if (!sheet) return null;
  const rowsCut = sheet.totalRows > SHEET_VIEW_MAX_ROWS;
  const colsCut = sheet.totalCols > SHEET_VIEW_MAX_COLS;
  if (!rowsCut && !colsCut) return null;
  return `Showing the first ${Math.min(sheet.totalRows, SHEET_VIEW_MAX_ROWS)} rows and ${Math.min(sheet.totalCols, SHEET_VIEW_MAX_COLS)} columns of ${sheet.totalRows} × ${sheet.totalCols}. Download it to see everything.`;
}

function SheetView({ source }: FileViewProps) {
  const { data, error, pending } = useWorkbook(source);
  const [active, setActive] = useState(0);
  if (pending) return <ViewerLoading />;
  if (error || !data) {
    return (
      <ViewerMessage kind={source.kind} title="Couldn't open this spreadsheet" tone="error">
        {viewerErrorText(error)}
      </ViewerMessage>
    );
  }
  const sheet = data.sheets[Math.min(active, data.sheets.length - 1)];
  if (!sheet) {
    return <ViewerMessage kind={source.kind} title="This spreadsheet has no sheets" />;
  }
  const note = truncationNote(data, active);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <SheetGrid
          key={active}
          cells={sheet.cells}
          editable={false}
          footer={
            note ? (
              <div className="shrink-0 border-t border-border bg-card px-3 py-1.5 text-[11px] text-muted-foreground">
                {note}
              </div>
            ) : null
          }
        />
      </div>
      <SheetTabs
        names={data.sheets.map((entry) => entry.name)}
        active={active}
        onSelect={setActive}
      />
    </div>
  );
}

function SheetEditor({ source, onClose, onDirtyChange }: FileEditorProps) {
  const { data, error, pending } = useWorkbook(source);
  const [active, setActive] = useState(0);
  const [edits, setEdits] = useState<Map<string, string>>(() => new Map());
  const [addedRows, setAddedRows] = useState<Map<number, number>>(() => new Map());
  const [addedCols, setAddedCols] = useState<Map<number, number>>(() => new Map());
  const [saving, setSaving] = useState<"replace" | "copy" | null>(null);
  const format = sheetFormatOf(source.name);
  const dirty = edits.size > 0 || addedRows.size > 0 || addedCols.size > 0;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const sheet = data?.sheets[Math.min(active, (data?.sheets.length ?? 1) - 1)];
  const cells = useMemo<ReadonlyArray<ReadonlyArray<SheetCell>>>(() => {
    if (!sheet) return [];
    const extraRows = addedRows.get(active) ?? 0;
    const extraCols = addedCols.get(active) ?? 0;
    const width = (sheet.cells[0]?.length ?? 1) + extraCols;
    const blank: SheetCell = { display: "", input: "" };
    const base = [...sheet.cells, ...Array.from({ length: extraRows }, () => [] as SheetCell[])];
    return base.map((row, rowIndex) => {
      let next: SheetCell[] | null = null;
      for (let col = 0; col < width; col += 1) {
        const edited = edits.get(editKey(active, rowIndex, col));
        if (edited === undefined && col < row.length) continue;
        next ??= [...row];
        next[col] = edited === undefined ? blank : { display: edited, input: edited };
      }
      return next ?? row;
    });
  }, [active, addedCols, addedRows, edits, sheet]);

  const editedCells = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const key of edits.keys()) {
      const [sheetIndex, row, col] = key.split(":").map(Number);
      if (sheetIndex !== active) continue;
      if (!map.has(row!)) map.set(row!, new Set());
      map.get(row!)!.add(col!);
    }
    return map;
  }, [active, edits]);

  const onCommit = useCallback(
    (row: number, col: number, input: string) => {
      setEdits((previous) => new Map(previous).set(editKey(active, row, col), input));
    },
    [active],
  );

  const save = async (mode: "replace" | "copy") => {
    if (!data) return;
    setSaving(mode);
    try {
      const written = writeWorkbookWithEdits(data, edits, { rows: addedRows, cols: addedCols });
      const bytes =
        format === "xlsx" || format === "xlsm" ? await markFullCalcOnLoad(written) : written;
      if (mode === "replace") {
        await source.save(bytes);
        toastManager.add({ type: "success", title: "Saved", description: source.name });
      } else {
        const copy = await createFile(
          source.environmentId,
          dirname(source.path),
          numberedCopyName(source.name),
          bytes,
        );
        toastManager.add({ type: "success", title: "Saved as a copy", description: copy.name });
      }
      onDirtyChange(false);
      onClose(true);
    } catch (saveError) {
      toastManager.add({
        type: "error",
        title: "Couldn't save",
        description: viewerErrorText(saveError),
      });
    } finally {
      setSaving(null);
    }
  };

  if (pending) return <ViewerLoading />;
  if (error || !data) {
    return (
      <ViewerMessage kind={source.kind} title="Couldn't open this spreadsheet" tone="error">
        {viewerErrorText(error)}
      </ViewerMessage>
    );
  }
  if (!isEditableSheetFormat(format)) {
    return (
      <ViewerMessage kind={source.kind} title="This format can't be edited in the browser">
        Download it, edit it in Excel or Numbers, then upload the new version.
      </ViewerMessage>
    );
  }
  if (!sheet) return <ViewerMessage kind={source.kind} title="This spreadsheet has no sheets" />;
  const truncated = data.sheets.some(
    (entry) => entry.totalRows > SHEET_VIEW_MAX_ROWS || entry.totalCols > SHEET_VIEW_MAX_COLS,
  );
  if (truncated && (format === "csv" || format === "tsv")) {
    return (
      <ViewerMessage kind={source.kind} title="This table is too big to edit here">
        Tables up to {SHEET_VIEW_MAX_ROWS} rows and {SHEET_VIEW_MAX_COLS} columns can be edited in
        the browser. Download it to edit it in Excel.
      </ViewerMessage>
    );
  }
  const risky = data.unsupportedParts.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setAddedRows((previous) =>
              new Map(previous).set(active, (previous.get(active) ?? 0) + 1),
            )
          }
        >
          <PlusIcon />
          Row
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setAddedCols((previous) =>
              new Map(previous).set(active, (previous.get(active) ?? 0) + 1),
            )
          }
        >
          <PlusIcon />
          Column
        </Button>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn("size-1.5 rounded-full", dirty ? "bg-warning" : "bg-success")}
            aria-hidden
          />
          {dirty
            ? `${edits.size} ${edits.size === 1 ? "cell" : "cells"} changed`
            : "No changes yet"}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => onClose(false)}
          disabled={saving !== null}
        >
          Cancel
        </Button>
        {risky ? (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void save("replace")}
              disabled={saving !== null || !dirty}
            >
              {saving === "replace" ? <Loader2Icon className="animate-spin" /> : null}
              Overwrite original
            </Button>
            <Button
              size="sm"
              onClick={() => void save("copy")}
              disabled={saving !== null || !dirty}
            >
              {saving === "copy" ? <Loader2Icon className="animate-spin" /> : null}
              Save as a copy
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => void save("replace")}
            disabled={saving !== null || !dirty}
          >
            {saving === "replace" ? <Loader2Icon className="animate-spin" /> : null}
            Save
          </Button>
        )}
      </div>
      {format === "xlsx" || format === "xlsm" ? (
        <div
          className={cn(
            "shrink-0 border-b px-3 py-1.5 text-[11px]",
            risky
              ? "border-warning/30 bg-warning/10 text-foreground"
              : "border-border bg-card text-muted-foreground",
          )}
        >
          {risky
            ? `This file has ${data.unsupportedParts.join(", ")}, which the browser editor can't keep. Save a copy, or download and edit it in Excel to keep them.`
            : "Values, formulas and sheets are kept when you save. Type = to start a formula."}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <SheetGrid
          key={active}
          cells={cells}
          editable
          editedCells={editedCells}
          onCommit={onCommit}
        />
      </div>
      <SheetTabs
        names={data.sheets.map((entry) => entry.name)}
        active={active}
        onSelect={setActive}
      />
    </div>
  );
}

export const sheetOpeners: ReadonlyArray<FileOpener> = [
  {
    id: "builtin.sheet",
    label: "Spreadsheet",
    match: (file) => (file.kind === "csv" || file.kind === "spreadsheet" ? 10 : 0),
    View: SheetView,
    Editor: SheetEditor,
    editLabel: "Edit cells",
    maxBytes: SHEET_MAX_BYTES,
  },
];
