/**
 * Projects on their way from the person's computer (13.11): each picked
 * project with "Copying…" until it is a project here, or why it didn't come
 * over. The copy runs on the cloud computer after Bring; this polls its
 * status while it runs (`useComputerWork`).
 */
import { AlertCircleIcon, CheckIcon, FolderGit2Icon, Loader2Icon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComputersHostId } from "../../computersLifecycle/useComputers";
import { useComputerWork } from "../../computersLifecycle/useComputerWork";
import { cn } from "../../lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { broughtRows, type BroughtRow, type KnownProject, type PickedProject } from "./devSetup";

/** The picked projects and how their copy goes. */
export function useBroughtRows(
  computerId: string | null,
  picks: ReadonlyArray<PickedProject>,
): { readonly rows: ReadonlyArray<BroughtRow>; readonly settled: boolean } {
  const hostId = useComputersHostId();
  const work = useComputerWork(computerId);
  const known = useStore(
    useShallow((state) =>
      selectProjectsAcrossEnvironments(state).filter((project) => project.environmentId === hostId),
    ),
  );
  const rows = useMemo(
    () =>
      broughtRows({
        picks,
        bring: work.status?.bring,
        known: known.map(
          (project): KnownProject => ({
            id: project.id,
            title: project.name,
            workspaceRoot: project.cwd,
          }),
        ),
      }),
    [known, picks, work.status?.bring],
  );
  return { rows, settled: work.settled };
}

function StateLine({ row }: { row: BroughtRow }) {
  switch (row.state.kind) {
    case "copying":
      return (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" />
          Copying…
        </span>
      );
    case "ready":
      return <span className="text-muted-foreground">{row.state.note ?? "Ready"}</span>;
    case "failed":
      return <span className="text-destructive-foreground">{row.state.message}</span>;
  }
}

function StateIcon({ row }: { row: BroughtRow }) {
  if (row.state.kind === "failed") {
    return <AlertCircleIcon className="size-4 text-destructive-foreground" aria-hidden />;
  }
  if (row.state.kind === "copying") {
    return <FolderGit2Icon className="size-4 text-muted-foreground" aria-hidden />;
  }
  return <CheckIcon className="size-4 text-success-foreground" aria-hidden />;
}

/**
 * The list. With `selected` + `onSelect` it is a radio group (the first chat
 * picks its project); without, a plain status list.
 */
export function BroughtProjectList({
  rows,
  selected,
  onSelect,
  shortPath,
}: {
  rows: ReadonlyArray<BroughtRow>;
  selected?: string | null;
  onSelect?: (path: string) => void;
  /** `~/projects/landing` for a folder here. */
  shortPath: (folder: string) => string;
}) {
  const selectable = onSelect !== undefined;
  return (
    <div
      role={selectable ? "radiogroup" : "list"}
      aria-label="Your projects"
      className="overflow-hidden rounded-2xl border border-border"
      data-testid="setup-brought"
    >
      {rows.map((row, index) => {
        const isSelected = selectable && row.path === selected;
        const detail = row.state.kind === "ready" ? shortPath(row.state.folder) : null;
        const content = (
          <>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
              <StateIcon row={row} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium">{row.name}</span>
                {detail ? (
                  <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
                    {detail}
                  </span>
                ) : null}
              </span>
              <span
                className={cn(
                  "mt-0.5 block text-xs",
                  // A failure says why in full; the rest fit on one line.
                  row.state.kind === "failed" ? "break-words" : "truncate",
                )}
              >
                <StateLine row={row} />
              </span>
            </span>
            {selectable ? (
              <span
                aria-hidden
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-full border-2",
                  isSelected ? "border-primary" : "border-border",
                )}
              >
                {isSelected ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
            ) : null}
          </>
        );
        const className = cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left text-sm outline-hidden transition-colors sm:px-5",
          index > 0 && "border-t border-border",
          isSelected && "bg-primary/[0.04] ring-1 ring-inset ring-primary/40",
        );
        return selectable ? (
          <button
            key={row.path}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(row.path)}
            data-testid={`setup-brought-${row.name}`}
            data-state={row.state.kind}
            className={cn(
              className,
              !isSelected && "hover:bg-muted/40",
              "focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            {content}
          </button>
        ) : (
          <div
            key={row.path}
            role="listitem"
            data-testid={`setup-brought-${row.name}`}
            data-state={row.state.kind}
            className={className}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}
