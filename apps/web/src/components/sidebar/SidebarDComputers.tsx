/**
 * Sidebar D with several computers (w0138 point 5): the computer chip on a
 * project or a chat that lives elsewhere, the computer headers of "Group by
 * computer", and the hooks that list the computers and their home folders.
 * With one computer none of this shows (see sidebarDView.logic.ts).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useMemo } from "react";

import { resolveHomeFolder } from "../../hooks/useFolderChats";
import { useMachineRows } from "../../hooks/useMachineRows";
import { cn } from "~/lib/utils";
import { MachineChip } from "../MachineChip";
import { useMachineIdentity } from "../MachineIdentityContext";
import type { SidebarDComputer } from "./sidebarDView.logic";

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
        })),
    [rows],
  );
}

/** Each computer's home folder (its chats there are the "Home folder"). */
export function useHomeFolderPaths(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<string, string> {
  return useQueries({
    queries: environmentIds.map((environmentId) => ({
      queryKey: ["uno-computer", "home-folder", environmentId],
      queryFn: () => resolveHomeFolder(environmentId),
      staleTime: Number.POSITIVE_INFINITY,
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

/** A computer's chip on a row; grey while it sleeps or can't be reached. */
export function SidebarDComputerChip(props: {
  environmentId: EnvironmentId;
  dimmed?: boolean;
  size?: "sm" | "default";
}) {
  const identity = useMachineIdentity(props.environmentId);
  return (
    <MachineChip
      identity={identity}
      size={props.size ?? "sm"}
      className={props.dimmed ? "opacity-50 grayscale" : undefined}
      detail={props.dimmed ? "Asleep or not reachable" : null}
    />
  );
}

/** A computer's chip for one that has no connection yet (asleep on the account). */
function SleepingChip(props: { label: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-[1.1875rem] shrink-0 items-center justify-center rounded-[.3125rem] bg-muted text-[.59375rem] font-semibold text-muted-foreground/60"
    >
      {props.label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * "Group by computer": the computer's line over its projects. Folds like a
 * project; a computer asleep or unreachable is grey and says so.
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
    <li className="group/computer list-none" data-testid="sidebar-d-computer">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={!props.folded}
        disabled={computer.environmentId === null}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md pr-2 pl-2 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent",
          props.dimmed && "opacity-60",
        )}
      >
        {computer.environmentId !== null ? (
          <SidebarDComputerChip
            environmentId={computer.environmentId as EnvironmentId}
            dimmed={props.dimmed}
            size="default"
          />
        ) : (
          <SleepingChip label={computer.label} />
        )}
        <span
          className={cn(
            "min-w-0 truncate text-xs font-semibold",
            props.dimmed ? "text-sidebar-muted-foreground" : "text-sidebar-foreground/85",
          )}
        >
          {computer.label}
        </span>
        {statusText ? (
          <span className="shrink-0 text-xs text-sidebar-muted-foreground/60">{statusText}</span>
        ) : null}
        {computer.environmentId !== null ? (
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "ml-auto size-3 shrink-0 text-muted-foreground opacity-0 transition group-hover/computer:opacity-100",
              !props.folded && "rotate-90",
              props.folded && "opacity-100",
            )}
          />
        ) : null}
      </button>
    </li>
  );
}
