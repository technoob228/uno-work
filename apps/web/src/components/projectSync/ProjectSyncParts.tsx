/**
 * "On all my computers" in the sidebar: the small mark on a project row
 * (✓ synced · ↻ syncing · ⚠ needs you), and "Projects on your other
 * computers" with Get it here.
 *
 * @module projectSync/ProjectSyncParts
 */
import type { EnvironmentId, ProjectSyncElsewhere, ProjectSyncEntry } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CloudCheckIcon,
  CloudDownloadIcon,
  CloudIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { SHARED_PROJECT_HERE, sharedWaitingLine, syncLabel, syncMarkOf } from "./projectSync.logic";
import { useRefreshProjectSync } from "./useProjectSync";

const RANK = { conflict: 5, problem: 4, held: 3, syncing: 2, synced: 1 } as const;

/** The most urgent entry of a project's copies on several computers. */
export function mostUrgent(entries: ReadonlyArray<ProjectSyncEntry>): ProjectSyncEntry | null {
  let best: ProjectSyncEntry | null = null;
  for (const entry of entries) {
    const mark = syncMarkOf(entry.state, entry.held);
    if (!mark) continue;
    const bestMark = best ? syncMarkOf(best.state, best.held) : null;
    if (!bestMark || RANK[mark] > RANK[bestMark]) best = entry;
  }
  return best;
}

/** The row's mark; ⚠ and problems open the project's settings (Keep mine / Keep theirs there). */
export function ProjectSyncMark(props: { entry: ProjectSyncEntry | null; onOpen: () => void }) {
  const { entry } = props;
  const mark = syncMarkOf(entry?.state, entry?.held);
  if (!entry || !mark) return null;
  const label = syncLabel(entry);
  const icon =
    mark === "synced" ? (
      <CloudCheckIcon className="size-3.5 text-muted-foreground/80" />
    ) : mark === "syncing" ? (
      <RefreshCwIcon className="size-3 animate-spin text-sky-500 [animation-duration:1.6s]" />
    ) : mark === "conflict" ? (
      <TriangleAlertIcon className="size-3.5 text-amber-500" />
    ) : mark === "held" ? (
      <KeyRoundIcon className="size-3.5 text-amber-500/80" />
    ) : (
      <CircleAlertIcon className="size-3.5 text-red-500" />
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="button"
            tabIndex={0}
            aria-label={label}
            data-testid={`project-sync-mark-${mark}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onOpen();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.stopPropagation();
                props.onOpen();
              }
            }}
            className={cn(
              "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm",
              mark === "synced" && "opacity-70",
            )}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {label}
        {mark === "conflict" ? " Click to choose." : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * "Projects on your other computers": cloud projects this computer doesn't
 * have yet. `arrivingTeam`: the shared project coming here by itself right now.
 */
export function ProjectsElsewhere(props: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<ProjectSyncElsewhere>;
  arrivingTeam: number | null;
}) {
  const refresh = useRefreshProjectSync();
  const [busy, setBusy] = useState<string | null>(null);
  if (props.projects.length === 0) return null;
  const rowOf = (project: ProjectSyncElsewhere) =>
    project.team ? `team:${project.team.id}` : project.name;
  const getHere = async (project: ProjectSyncElsewhere) => {
    const api = readEnvironmentApi(props.environmentId);
    if (!api) return;
    const { name, team } = project;
    setBusy(rowOf(project));
    try {
      const result = await api.projectSync.getHere({
        name,
        ...(team ? { teamId: team.id } : {}),
      });
      refresh(props.environmentId, result.entry);
      toastManager.add({
        type: "success",
        title: `${name} is on this computer`,
        description: team
          ? SHARED_PROJECT_HERE
          : "It stays the same on all your computers. Its keys came with it.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Couldn't get ${name}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <li
        aria-hidden
        className="list-none px-2.5 pt-3 pb-1 text-xs font-medium text-sidebar-muted-foreground/70"
      >
        Projects on your other computers
      </li>
      {props.projects.map((project) => (
        <li
          key={rowOf(project)}
          className="group/elsewhere list-none"
          data-testid="sidebar-project-elsewhere"
        >
          <div className="flex h-8 w-full items-center gap-2 rounded-md pl-2.5 pr-1 text-sm text-sidebar-foreground/60 hover:bg-sidebar-row-hover">
            <CloudIcon className="size-4 shrink-0 text-muted-foreground/70" />
            <span className="min-w-0 truncate">{project.name}</span>
            {project.from ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground/70">
                {project.from}
              </span>
            ) : null}
            <span className="flex-1" />
            {project.waiting ? null : (
              <button
                type="button"
                disabled={busy !== null || props.arrivingTeam !== null}
                onClick={() => void getHere(project)}
                className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-foreground/80 hover:bg-accent disabled:cursor-wait disabled:opacity-60"
              >
                {busy === rowOf(project) ||
                (project.team && project.team.id === props.arrivingTeam) ? (
                  <RefreshCwIcon className="size-3 animate-spin" />
                ) : (
                  <CloudDownloadIcon className="size-3" />
                )}
                Get it here
              </button>
            )}
          </div>
          {project.waiting ? (
            <p className="px-2.5 pb-1 text-xs text-sidebar-muted-foreground/70">
              {sharedWaitingLine(project.name)}
            </p>
          ) : null}
        </li>
      ))}
    </>
  );
}
