/**
 * Sidebar D with several computers (w0138 point 5): the computer mark on a
 * project or a chat that lives elsewhere, the computer sections of "By
 * computer", and the hooks that list the computers and their home folders.
 * With one computer none of this shows (see sidebarDView.logic.ts).
 *
 * The mark is an icon — a laptop, or a cloud for an Uno computer — with the
 * name in its tooltip (critics 16.10: "MA / UP / UW" chips read as nothing).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { ChevronRightIcon, CloudIcon, LaptopIcon } from "lucide-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { resolveHomeFolder } from "../../hooks/useFolderChats";
import { useMachineRows } from "../../hooks/useMachineRows";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isComputerDimmed, type SidebarDComputer } from "./sidebarDView.logic";

/** Every computer the sidebar can name: connected ones and the ones asleep on the account. */
export function useSidebarDComputers(): ReadonlyArray<SidebarDComputer> {
  const rows = useMachineRows();
  return useMemo(
    () =>
      rows
        .filter((row) => row.environmentId !== null || row.status === "sleeping")
        .map((row) => ({
          environmentId: row.environmentId,
          key: row.key,
          label: row.label,
          status: row.status,
          cloud: row.kind === "uno_box",
        })),
    [rows],
  );
}

/** A computer not connected yet answers no home folder: ask again after this. */
const HOME_FOLDER_RETRY_MS = 30_000;

/**
 * Each computer's home folder (its chats there are the "Home folder"), asked
 * of the computer's daemon (filesystem.browse "~"). A computer that isn't
 * connected (yet) answers null without a request; that answer goes stale so
 * the next focus asks again, while the sidebar falls back to the project's
 * "Home folder" name in the meantime.
 */
export function useHomeFolderPaths(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<string, string> {
  return useQueries({
    queries: environmentIds.map((environmentId) => ({
      queryKey: ["uno-computer", "home-folder", environmentId],
      queryFn: () => resolveHomeFolder(environmentId),
      staleTime: (query: { state: { data: string | null | undefined } }) =>
        query.state.data ? Number.POSITIVE_INFINITY : HOME_FOLDER_RETRY_MS,
    })),
    combine: (results) => {
      const paths = new Map<string, string>();
      results.forEach((result, index) => {
        const path = result.data;
        if (path) paths.set(environmentIds[index]!, path.replace(/\/+$/, ""));
      });
      return paths;
    },
  });
}

/** The computers the sidebar knows, by environment id, for the marks on its rows. */
const ComputersContext = createContext<ReadonlyMap<string, SidebarDComputer>>(new Map());

export function SidebarDComputersProvider(props: {
  computers: ReadonlyArray<SidebarDComputer>;
  children: ReactNode;
}) {
  const byId = useMemo(
    () =>
      new Map(
        props.computers.flatMap((computer) =>
          computer.environmentId === null ? [] : [[computer.environmentId, computer] as const],
        ),
      ),
    [props.computers],
  );
  return <ComputersContext.Provider value={byId}>{props.children}</ComputersContext.Provider>;
}

function ComputerIcon(props: { cloud: boolean; className?: string }) {
  return props.cloud ? (
    <CloudIcon aria-hidden className={cn("size-3 shrink-0", props.className)} />
  ) : (
    <LaptopIcon aria-hidden className={cn("size-3 shrink-0", props.className)} />
  );
}

/** A computer's mark on a row: its icon, the name in the tooltip; grey while asleep. */
export function SidebarDComputerChip(props: { environmentId: EnvironmentId | string }) {
  const computer = useContext(ComputersContext).get(props.environmentId);
  const label = computer?.label ?? "Another computer";
  const dimmed = computer ? isComputerDimmed(computer) : false;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`On ${label}`}
            data-testid="sidebar-d-computer-mark"
            className={cn(
              "inline-flex shrink-0 items-center text-muted-foreground/70",
              dimmed && "opacity-50",
            )}
          />
        }
      >
        <ComputerIcon cloud={computer?.cloud ?? false} />
      </TooltipTrigger>
      <TooltipPopup side="top">
        On {label}
        {dimmed ? " · asleep" : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The icon alone (menus: the item already names the computer). */
export function SidebarDComputerIcon(props: { computer: SidebarDComputer }) {
  return (
    <ComputerIcon
      cloud={props.computer.cloud ?? false}
      className={cn("text-muted-foreground", isComputerDimmed(props.computer) && "opacity-50")}
    />
  );
}

/**
 * "By computer": the computer is the section's quiet 11px label over its
 * projects (critics 16.10: the computer read heavier than the projects).
 * Folds like a project; one asleep or unreachable is grey and says so.
 */
export function SidebarDComputerHeader(props: {
  computer: SidebarDComputer;
  isThis: boolean;
  dimmed: boolean;
  folded: boolean;
  onToggle: () => void;
}) {
  const { computer } = props;
  const statusText =
    computer.status === "sleeping"
      ? "Asleep"
      : computer.status === "offline"
        ? "Not reachable"
        : props.isThis
          ? "This computer"
          : null;
  return (
    <li className="group/computer list-none pt-1" data-testid="sidebar-d-computer">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={!props.folded}
        disabled={computer.environmentId === null}
        className={cn(
          "flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 pl-1 text-left text-[11px] font-medium text-sidebar-muted-foreground/80 outline-hidden hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:text-sidebar-muted-foreground/80",
          props.dimmed && "opacity-60",
        )}
      >
        <ComputerIcon cloud={computer.cloud ?? false} />
        <span className="min-w-0 truncate">{computer.label}</span>
        {statusText ? (
          <span className="shrink-0 font-normal text-sidebar-muted-foreground/60">
            · {statusText}
          </span>
        ) : null}
        {computer.environmentId !== null ? (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "ml-auto size-3 shrink-0 opacity-0 transition group-hover/computer:opacity-100",
              !props.folded && "rotate-90",
              props.folded && "opacity-100",
            )}
          />
        ) : null}
      </button>
    </li>
  );
}
