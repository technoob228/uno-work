/**
 * "Where does a new chat work?" — one answer for every entry point: the home
 * folder, unless the person picks another one. A folder is a project under the
 * hood; the home folder becomes a "Home folder" project the first time a chat
 * starts there. Picking another folder never needs a typed path (see
 * `FolderChipMenu` / `ChatInFolderDialog`).
 *
 * Used by New chat (sidebar, rail, ⇧⌘O), Home's composer, the Uno program,
 * Terminal, and the folder chip on a new chat that moves the draft.
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  DEFAULT_MODEL,
  ProviderInstanceId,
  isAssistantProjectId,
  type EnvironmentId,
  type ModelSelection,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { ensureEnvironmentApi } from "../environmentApi";
import { useEnvironmentProviders } from "../environments/settings/serverSettings";
import { HOME_FOLDER_TITLE } from "../lib/homeFolder";
import { findProjectByPath, inferProjectTitleFromPath } from "../lib/projectPaths";
import { newCommandId, newProjectId } from "../lib/utils";
import { pickUsableDefaultModelSelection } from "../providerModels";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useNewThreadHandler } from "./useHandleNewThread";

export { HOME_FOLDER_TITLE };

const homeFolderByEnvironment = new Map<EnvironmentId, string>();

/** The machine's home folder (`~`, resolved by the daemon); null when unreachable. */
export async function resolveHomeFolder(environmentId: EnvironmentId): Promise<string | null> {
  const cached = homeFolderByEnvironment.get(environmentId);
  if (cached) return cached;
  try {
    const home = (await ensureEnvironmentApi(environmentId).filesystem.browse({ partialPath: "~" }))
      .parentPath;
    if (home) homeFolderByEnvironment.set(environmentId, home);
    return home || null;
  } catch {
    return null;
  }
}

/** The home folder for rendering ("is this chat in the home folder?"). */
export function useHomeFolderPath(environmentId: EnvironmentId | null): string | null {
  return (
    useQuery({
      queryKey: ["uno-computer", "home-folder", environmentId],
      queryFn: () => resolveHomeFolder(environmentId!),
      enabled: environmentId !== null,
      staleTime: Number.POSITIVE_INFINITY,
    }).data ?? null
  );
}

export function folderDisplayName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export function useFolderChats(environmentId: EnvironmentId | null) {
  const { handleNewThread } = useNewThreadHandler();
  const router = useRouter();
  const providers = useEnvironmentProviders(environmentId);

  /** The project for `folder` on this machine, created when it isn't one yet. */
  const ensureFolderProject = useCallback(
    async (
      folder: string,
      title?: string,
      options?: {
        readonly createFolder?: boolean;
        /** The new project's default model; the machine's usable default otherwise. */
        readonly defaultModelSelection?: ModelSelection | null;
      },
    ): Promise<ScopedProjectRef> => {
      if (environmentId === null) throw new Error("No connection to this computer.");
      const existing = findProjectByPath(
        selectProjectsAcrossEnvironments(useStore.getState()).filter(
          (project) => project.environmentId === environmentId && !isAssistantProjectId(project.id),
        ),
        folder,
      );
      if (existing) return scopeProjectRef(environmentId, existing.id);
      const selection =
        options?.defaultModelSelection ?? pickUsableDefaultModelSelection(providers);
      const projectId = newProjectId();
      await ensureEnvironmentApi(environmentId).orchestration.dispatchCommand({
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        title: title ?? inferProjectTitleFromPath(folder),
        workspaceRoot: folder,
        // "Empty project" makes the folder; every other path points at one
        // that is already there.
        createWorkspaceRootIfMissing: options?.createFolder === true,
        defaultModelSelection: selection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        createdAt: new Date().toISOString(),
      });
      return scopeProjectRef(environmentId, projectId);
    },
    [environmentId, providers],
  );

  /** A new chat in `folder` (a project already, or made one). */
  const chatInFolder = useCallback(
    async (
      folder: string,
      title?: string,
      options?: { readonly createFolder?: boolean },
    ): Promise<ScopedProjectRef> => {
      const projectRef = await ensureFolderProject(folder, title, options);
      await handleNewThread(projectRef, { envMode: "local" });
      return projectRef;
    },
    [ensureFolderProject, handleNewThread],
  );

  /**
   * A new chat in the home folder. Null when the home folder can't be
   * resolved (machine unreachable) — the caller falls back to its old path.
   */
  const chatInHomeFolder = useCallback(async (): Promise<ScopedProjectRef | null> => {
    if (environmentId === null) return null;
    const home = await resolveHomeFolder(environmentId);
    if (!home) return null;
    return chatInFolder(home, HOME_FOLDER_TITLE);
  }, [chatInFolder, environmentId]);

  /**
   * The folder chip on a new (unsent) chat: the chat moves to `folder` (null
   * = home) with what was typed, the model and the permissions carried over.
   */
  const moveDraftToFolder = useCallback(
    async (draftId: DraftId, folder: string | null): Promise<void> => {
      if (environmentId === null) return;
      const target = folder ?? (await resolveHomeFolder(environmentId));
      if (!target) throw new Error("Couldn't find the home folder on this computer.");
      const store = useComposerDraftStore.getState();
      const before = store.getComposerDraft(draftId);
      const prompt = before?.prompt ?? "";
      const modelSelection = before?.activeProvider
        ? before.modelSelectionByProvider[before.activeProvider]
        : undefined;
      const runtimeMode = before?.runtimeMode ?? null;
      await chatInFolder(target, folder ? undefined : HOME_FOLDER_TITLE);
      // The draft the chat opened on — read from the route: a project can have
      // drafts under two keys (scoped id / logical path), the route is the truth.
      const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const route = resolveThreadRouteTarget(params);
      if (route?.kind !== "draft" || route.draftId === draftId) return;
      const moved = route.draftId;
      const next = useComposerDraftStore.getState();
      if (prompt) {
        next.setPrompt(moved, prompt);
        next.setPrompt(draftId, "");
      }
      if (modelSelection) next.setModelSelection(moved, modelSelection);
      if (runtimeMode) {
        next.setRuntimeMode(moved, runtimeMode);
        next.setDraftThreadContext(moved, { runtimeMode });
      }
    },
    [chatInFolder, environmentId, router],
  );

  return { ensureFolderProject, chatInFolder, chatInHomeFolder, moveDraftToFolder };
}
