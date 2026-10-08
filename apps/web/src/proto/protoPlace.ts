/**
 * Sidebar prototype (w0115, NOT FOR MERGE): "where is this chat" — the folder
 * (only when it isn't the Home folder) and, with computers joined (Б), the
 * computer. One wording for the sidebar, the Inbox and Home.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { useStore } from "../store";
import type { Project } from "../types";
import { MACHINES } from "./fixtures";
import { PROTO, useProtoStore, type ProtoMode } from "./protoState";

export function machineLabel(environmentId: string): string {
  return MACHINES[environmentId]?.label ?? "Computer";
}

export function isHomeProject(project: Pick<Project, "name" | "cwd" | "environmentId">): boolean {
  const home = MACHINES[project.environmentId]?.home;
  return (
    project.name === "Home folder" ||
    (home !== undefined && project.cwd.replace(/\/+$/, "") === home)
  );
}

export function projectKeyOf(project: Pick<Project, "environmentId" | "id">): string {
  return `${project.environmentId}:${project.id}`;
}

/** "yoga-site", "MacBook · brand-kit", "MacBook" — or null when there is nothing to add. */
export function placeLabel(input: {
  mode: ProtoMode;
  environmentId: string;
  project: Pick<Project, "name" | "cwd" | "environmentId"> | null | undefined;
  /** The list is already narrowed to this project: the folder goes without saying. */
  hideFolder?: boolean;
}): string | null {
  const home = !input.project || isHomeProject(input.project);
  const folder = home || input.hideFolder ? null : input.project!.name;
  if (input.mode === "one") return folder;
  const machine = machineLabel(input.environmentId);
  return folder ? `${machine} · ${folder}` : machine;
}

/** The place label of a chat by its ids (Inbox, Home); null outside the prototype. */
export function useProtoChatPlace(
  environmentId: EnvironmentId | string,
  threadId: string | null,
  options?: { onlyWhenJoined?: boolean },
): string | null {
  const mode = useProtoStore((state) => state.mode);
  const project = useStore((state) => {
    if (!PROTO || threadId === null) return null;
    const env = state.environmentStateById[environmentId];
    const summary = env?.sidebarThreadSummaryById[threadId as never];
    if (!summary) return null;
    return env?.projectById?.[summary.projectId as never] ?? null;
  });
  if (!PROTO) return null;
  if (options?.onlyWhenJoined && mode === "one") return null;
  return placeLabel({ mode, environmentId, project: project as Project | null });
}
