/**
 * Sidebar prototype (w0115, NOT FOR MERGE): "where is this chat" — the
 * project (only when it isn't the Home folder) and, with 2+ computers in view,
 * the computer. One wording for the sidebar, the Inbox and Home:
 * "brand-kit · MacBook".
 *
 * One project on several computers: two folders are the same project when
 * they are the same git repository (the daemon's repositoryIdentity — same
 * remote; a shared Uno folder is a repository on our git, so it matches the
 * same way). Then the project key is the repository's, not the computer's.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { useStore } from "../store";
import type { Project } from "../types";
import { useComputerNames } from "./computerNames";
import { PROTO, useProtoStore, type ProtoMode } from "./protoState";

export const NO_PROJECT = "No project";
/** Logical key of the Home folders of every computer. */
export const NO_PROJECT_KEY = "none";

export function machineLabel(environmentId: string): string {
  return useComputerNames.getState().byId[environmentId]?.label ?? "Computer";
}

export function machineKind(environmentId: string): "uno_box" | "computer" {
  return useComputerNames.getState().byId[environmentId]?.kind ?? "computer";
}

/** Computers in a fixed order (cloud first, then by name), for menus and groups. */
export function machineOrder(): ReadonlyArray<string> {
  return useComputerNames.getState().order;
}

export function isHomeProject(project: Pick<Project, "name" | "cwd" | "environmentId">): boolean {
  const home = useComputerNames.getState().byId[project.environmentId]?.home ?? undefined;
  return (
    project.name === "Home folder" ||
    (home !== undefined && project.cwd.replace(/\/+$/, "") === home)
  );
}

export function projectKeyOf(project: Pick<Project, "environmentId" | "id">): string {
  return `${project.environmentId}:${project.id}`;
}

/** One key for one project across computers (same repository = same project). */
export function logicalKeyOf(
  project: Pick<Project, "environmentId" | "id" | "name" | "cwd" | "repositoryIdentity">,
): string {
  if (isHomeProject(project)) return NO_PROJECT_KEY;
  const canonical = project.repositoryIdentity?.canonicalKey;
  return canonical ? `repo:${canonical}` : projectKeyOf(project);
}

export interface PlaceParts {
  readonly project: string | null;
  readonly computer: string | null;
  readonly computerKind: "uno_box" | "computer" | null;
}

/** What to say about a chat's place, leaving out what the list already says. */
export function placeParts(input: {
  environmentId: string;
  project: Pick<Project, "name" | "cwd" | "environmentId"> | null | undefined;
  showProject: boolean;
  showComputer: boolean;
  /** Say "No project" for a Home-folder chat, so no row is left bare (critics 3–4). */
  sayNoProject?: boolean;
}): PlaceParts {
  const home = !input.project || isHomeProject(input.project);
  const project = !input.showProject
    ? null
    : home
      ? input.sayNoProject
        ? NO_PROJECT
        : null
      : input.project!.name;
  return {
    project,
    computer: input.showComputer ? machineLabel(input.environmentId) : null,
    computerKind: input.showComputer ? machineKind(input.environmentId) : null,
  };
}

/** "yoga-site", "brand-kit · MacBook", "MacBook" — or null when there is nothing to add. */
export function placeLabel(input: {
  mode: ProtoMode;
  environmentId: string;
  project: Pick<Project, "name" | "cwd" | "environmentId"> | null | undefined;
  /** The list is already narrowed to this project: the folder goes without saying. */
  hideFolder?: boolean;
}): string | null {
  const parts = placeParts({
    environmentId: input.environmentId,
    project: input.project,
    showProject: !input.hideFolder,
    showComputer: input.mode === "all",
  });
  const text = [parts.project, parts.computer].filter(Boolean).join(" · ");
  return text || null;
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
