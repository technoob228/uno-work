/**
 * The table surface for CSV and Excel: column letters and row numbers, a cell
 * cursor, a formula bar, sheet tabs. Read-only in view mode; in edit mode a
 * cell is typed into directly (Enter ↓, Tab →, Esc cancels), like a
 * spreadsheet app. Rows are memoized so typing in one cell repaints one row.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { spreadsheetColumnLabel } from "../../preview/previewFileUtils";
import { cellAddress, type SheetCell } from "./sheetModel";

export interface GridCursor {
  readonly row: number;
  readonly col: number;
}

interface RowProps {
  readonly rowIndex: number;
  readonly cells: ReadonlyArray<SheetCell>;
  readonly edited: ReadonlySet<number> | undefined;
  readonly cursorCol: number | null;
  readonly editingCol: number | null;
  readonly editValue: string;
  readonly onSelect: (row: number, col: number, startEdit: boolean) => void;
  readonly onEditValue: (value: string) => void;
  readonly onEditKey: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  readonly onEditBlur: () => void;
}

const GridRow = memo(function GridRow({
  rowIndex,
  cells,
  edited,
  cursorCol,
  editingCol,
  editValue,
  onSelect,
  onEditValue,
  onEditKey,
  onEditBlur,
}: RowProps) {
  return (
    <tr>
      <th className="sticky left-0 z-10 h-7 min-w-11 border-r border-b border-border bg-muted px-2 text-right text-[11px] font-normal text-muted-foreground tabular-nums">
        {rowIndex + 1}
      </th>
      {cells.map((cell, colIndex) => {
        const isCursor = cursorCol === colIndex;
        const isEditing = editingCol === colIndex;
        const numeric = /^-?[\d.,\s%$€£]+$/.test(cell.display) && cell.display.trim() !== "";
        return (
          <td
            key={colIndex}
            data-cell={`${rowIndex}:${colIndex}`}
            onMouseDown={(event) => {
              if (isEditing) return;
              event.preventDefault();
              onSelect(rowIndex, colIndex, event.detail >= 2);
            }}
            className={cn(
              "relative h-7 max-w-80 min-w-24 border-r border-b border-border px-2 align-middle text-[13px] whitespace-nowrap",
              numeric ? "text-right tabular-nums" : "text-left",
              edited?.has(colIndex) ? "bg-warning/10" : "",
              isCursor ? "outline-2 -outline-offset-2 outline-primary" : "",
            )}
          >
            {isEditing ? (
              <input
                autoFocus
                value={editValue}
                onChange={(event) => onEditValue(event.target.value)}
                onKeyDown={onEditKey}
                onBlur={onEditBlur}
                spellCheck={false}
                className="absolute inset-0 w-full min-w-24 border-0 bg-background px-2 text-[13px] outline-2 -outline-offset-2 outline-primary"
              />
            ) : (
              <span className="block overflow-hidden text-ellipsis">{cell.display}</span>
            )}
          </td>
        );
      })}
    </tr>
  );
});

export function SheetGrid({
  cells,
  editable,
  editedCells,
  onCommit,
  footer,
}: {
  readonly cells: ReadonlyArray<ReadonlyArray<SheetCell>>;
  readonly editable: boolean;
  /** Row → edited column indexes (highlighted). */
  readonly editedCells?: ReadonlyMap<number, ReadonlySet<number>>;
  readonly onCommit?: (row: number, col: number, input: string) => void;
  readonly footer?: React.ReactNode;
}) {
  const [cursor, setCursor] = useState<GridCursor>({ row: 0, col: 0 });
  const [editing, setEditing] = useState<{
    row: number;
    col: number;
    value: string;
    /** Typing in the formula bar rather than in the cell itself. */
    inBar: boolean;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rowCount = cells.length;
  const colCount = cells[0]?.length ?? 0;
  const current = cells[cursor.row]?.[cursor.col];

  const move = useCallback(
    (row: number, col: number) => {
      const next = {
        row: Math.max(0, Math.min(rowCount - 1, row)),
        col: Math.max(0, Math.min(colCount - 1, col)),
      };
      setCursor(next);
      containerRef.current
        ?.querySelector(`[data-cell="${next.row}:${next.col}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    [colCount, rowCount],
  );

  const startEdit = useCallback(
    (row: number, col: number, initial?: string, inBar = false) => {
      if (!editable) return;
      setEditing({ row, col, value: initial ?? cells[row]?.[col]?.input ?? "", inBar });
    },
    [cells, editable],
  );

  const commit = useCallback(() => {
    if (!editing) return;
    const original = cells[editing.row]?.[editing.col]?.input ?? "";
    if (editing.value !== original) onCommit?.(editing.row, editing.col, editing.value);
    setEditing(null);
  }, [cells, editing, onCommit]);

  const onSelect = useCallback(
    (row: number, col: number, dbl: boolean) => {
      if (editing) commit();
      setCursor({ row, col });
      containerRef.current?.focus();
      if (dbl) startEdit(row, col);
    },
    [commit, editing, startEdit],
  );

  const onEditKey = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (!editing) return;
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        commit();
        if (event.key === "Enter") move(editing.row + (event.shiftKey ? -1 : 1), editing.col);
        else move(editing.row, editing.col + (event.shiftKey ? -1 : 1));
        containerRef.current?.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setEditing(null);
        containerRef.current?.focus();
      }
    },
    [commit, editing, move],
  );

  const onGridKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const { row, col } = cursor;
    const keyMoves: Record<string, [number, number]> = {
      ArrowUp: [row - 1, col],
      ArrowDown: [row + 1, col],
      ArrowLeft: [row, col - 1],
      ArrowRight: [row, col + 1],
      Tab: [row, col + (event.shiftKey ? -1 : 1)],
      Enter: [row + (event.shiftKey ? -1 : 1), col],
    };
    const target = keyMoves[event.key];
    if (target && !(event.key === "Enter" && editable)) {
      event.preventDefault();
      move(target[0], target[1]);
      return;
    }
    if (!editable) return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      startEdit(row, col);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if ((cells[row]?.[col]?.input ?? "") !== "") onCommit?.(row, col, "");
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      startEdit(row, col, event.key);
    }
  };

  useEffect(() => {
    setCursor((previous) => ({
      row: Math.min(previous.row, Math.max(0, rowCount - 1)),
      col: Math.min(previous.col, Math.max(0, colCount - 1)),
    }));
  }, [colCount, rowCount]);

  const setEditValue = useCallback(
    (value: string) => setEditing((previous) => (previous ? { ...previous, value } : previous)),
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5">
        <span className="w-14 shrink-0 rounded border border-border bg-background px-2 py-0.5 text-center font-mono text-xs text-muted-foreground">
          {cellAddress(cursor.row, cursor.col)}
        </span>
        <span className="text-xs text-muted-foreground italic">fx</span>
        <input
          value={editing ? editing.value : (current?.input ?? "")}
          readOnly={!editable}
          onFocus={() => {
            if (editable && !editing) startEdit(cursor.row, cursor.col, undefined, true);
          }}
          onChange={(event) => setEditValue(event.target.value)}
          onKeyDown={onEditKey}
          onBlur={() => commit()}
          spellCheck={false}
          aria-label="Cell contents"
          className="h-7 min-w-0 flex-1 rounded border border-transparent bg-transparent px-2 font-mono text-xs text-foreground outline-none focus:border-border focus:bg-background"
        />
      </div>
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onGridKey}
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <table className="border-separate border-spacing-0 bg-background">
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-30 h-7 min-w-11 border-r border-b border-border bg-muted" />
              {Array.from({ length: colCount }, (_, colIndex) => (
                <th
                  key={colIndex}
                  className={cn(
                    "sticky top-0 z-20 h-7 min-w-24 border-r border-b border-border bg-muted px-2 text-center text-[11px] font-normal text-muted-foreground",
                    cursor.col === colIndex ? "bg-primary/10 text-foreground" : "",
                  )}
                >
                  {spreadsheetColumnLabel(colIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((row, rowIndex) => (
              <GridRow
                key={rowIndex}
                rowIndex={rowIndex}
                cells={row}
                edited={editedCells?.get(rowIndex)}
                cursorCol={cursor.row === rowIndex ? cursor.col : null}
                editingCol={editing && !editing.inBar && editing.row === rowIndex ? editing.col : null}
                editValue={editing?.row === rowIndex ? editing.value : ""}
                onSelect={onSelect}
                onEditValue={setEditValue}
                onEditKey={onEditKey}
                onEditBlur={commit}
              />
            ))}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}
