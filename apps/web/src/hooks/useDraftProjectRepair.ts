/**
 * A new chat is a dead end without its project: nothing to send to, no folder
 * in the headline. A draft can lose it two ways: saved by a build that wrote
 * the project's path over its id on reload (`normalizePersistedDraftThreads`,
 * 30.10), or the project is gone. The first finds its project by that path;
 * the second moves to the home folder with what was typed, like the folder
 * picker does.
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import type { ProjectId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useComposerDraftStore, type DraftId, type DraftSessionState } from "../composerDraftStore";
import { findProjectByPath } from "../lib/projectPaths";
import { selectEnvironmentState, useStore } from "../store";
import { useFolderChats } from "./useFolderChats";

export type DraftProjectRepair =
  | { readonly kind: "none" }
  | { readonly kind: "relink"; readonly projectId: ProjectId }
  | { readonly kind: "move-home" };

/** The path a draft remembers its project by, if any. */
function draftProjectPath(draft: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly logicalProjectKey: string;
}): string | null {
  if (/[/\\]/.test(draft.projectId)) return draft.projectId;
  const prefix = `${draft.environmentId}:`;
  if (!draft.logicalProjectKey.startsWith(prefix)) return null;
  const rest = draft.logicalProjectKey.slice(prefix.length);
  return /[/\\]/.test(rest) ? rest : null;
}

export function draftProjectRepair(input: {
  readonly draft: {
    readonly environmentId: string;
    readonly projectId: string;
    readonly logicalProjectKey: string;
  };
  /** Every project of the draft's computer, once it has told them. */
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly cwd: string }>;
}): DraftProjectRepair {
  const { draft, projects } = input;
  if (projects.some((project) => project.id === draft.projectId)) return { kind: "none" };
  const path = draftProjectPath(draft);
  const byPath = path ? findProjectByPath(projects, path) : undefined;
  return byPath ? { kind: "relink", projectId: byPath.id } : { kind: "move-home" };
}

export function useDraftProjectRepair(
  draftId: DraftId | null,
  draft: DraftSessionState | null,
): void {
  const environmentId = draft?.environmentId ?? null;
  const { moveDraftToFolder } = useFolderChats(environmentId);
  // The computer's projects are known: before that a project isn't missing, only not here yet.
  const ready = useStore((state) =>
    environmentId ? selectEnvironmentState(state, environmentId).bootstrapComplete : false,
  );
  const projectKnown = useStore((state) =>
    environmentId && draft
      ? selectEnvironmentState(state, environmentId).projectById[draft.projectId] !== undefined
      : false,
  );
  const movedDraftId = useRef<DraftId | null>(null);

  useEffect(() => {
    if (!draftId || !draft || !environmentId || !ready || projectKnown) return;
    if (draft.promotedTo) return;
    const environment = selectEnvironmentState(useStore.getState(), environmentId);
    const repair = draftProjectRepair({
      draft,
      projects: environment.projectIds.flatMap((id) => {
        const project = environment.projectById[id];
        return project ? [project] : [];
      }),
    });
    if (repair.kind === "relink") {
      useComposerDraftStore.getState().setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(environmentId, repair.projectId),
      });
      return;
    }
    if (repair.kind === "move-home" && movedDraftId.current !== draftId) {
      movedDraftId.current = draftId;
      // Not reachable right now: the composer says so when the person sends.
      void moveDraftToFolder(draftId, null).catch(() => undefined);
    }
  }, [draft, draftId, environmentId, moveDraftToFolder, projectKnown, ready]);
}
