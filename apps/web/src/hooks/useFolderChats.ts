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
  type RuntimeMode,
  type ScopedProjectRef,
  type ServerProvider,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { ensureEnvironmentApi } from "../environmentApi";
import {
  readEnvironmentServerConfig,
  useEnvironmentProviders,
} from "../environments/settings/serverSettings";
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

export interface EnsureFolderProjectOptions {
  readonly createFolder?: boolean;
  /** The new project's default model; the machine's usable default otherwise. */
  readonly defaultModelSelection?: ModelSelection | null;
}

/**
 * The project for `folder` on `environmentId`, created when it isn't one yet.
 * `providers`: the machine's harnesses for the new project's default model
 * (read from its config when not given — any connected computer, not only
 * the one on screen).
 */
export async function ensureFolderProjectOn(
  environmentId: EnvironmentId,
  folder: string,
  title?: string,
  options?: EnsureFolderProjectOptions & { readonly providers?: ReadonlyArray<ServerProvider> },
): Promise<ScopedProjectRef> {
  const existing = findProjectByPath(
    selectProjectsAcrossEnvironments(useStore.getState()).filter(
      (project) => project.environmentId === environmentId && !isAssistantProjectId(project.id),
    ),
    folder,
  );
  if (existing) return scopeProjectRef(environmentId, existing.id);
  const providers =
    options?.providers ?? readEnvironmentServerConfig(environmentId)?.providers ?? [];
  const selection = options?.defaultModelSelection ?? pickUsableDefaultModelSelection(providers);
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
}

/** What a new chat carries when it moves (folder or computer): the words, model, permissions. */
interface DraftCarry {
  readonly prompt: string;
  readonly modelSelection: ModelSelection | undefined;
  readonly runtimeMode: RuntimeMode | null;
}

function readDraftCarry(draftId: DraftId): DraftCarry {
  const before = useComposerDraftStore.getState().getComposerDraft(draftId);
  return {
    prompt: before?.prompt ?? "",
    modelSelection: before?.activeProvider
      ? before.modelSelectionByProvider[before.activeProvider]
      : undefined,
    runtimeMode: before?.runtimeMode ?? null,
  };
}

/**
 * After the move: the draft the chat opened on — read from the route (a
 * project can have drafts under two keys, scoped id / logical path; the route
 * is the truth) — gets what was typed, and the old draft lets it go.
 */
function applyDraftCarry(
  router: ReturnType<typeof useRouter>,
  draftId: DraftId,
  carry: DraftCarry,
  options: { readonly keepModel: boolean },
): void {
  const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
  const route = resolveThreadRouteTarget(params);
  if (route?.kind !== "draft" || route.draftId === draftId) return;
  const moved = route.draftId;
  const next = useComposerDraftStore.getState();
  if (carry.prompt) {
    next.setPrompt(moved, carry.prompt);
    next.setPrompt(draftId, "");
  }
  if (options.keepModel && carry.modelSelection) {
    next.setModelSelection(moved, carry.modelSelection);
  }
  if (carry.runtimeMode) {
    next.setRuntimeMode(moved, carry.runtimeMode);
    next.setDraftThreadContext(moved, { runtimeMode: carry.runtimeMode });
  }
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
      options?: EnsureFolderProjectOptions,
    ): Promise<ScopedProjectRef> => {
      if (environmentId === null) throw new Error("No connection to this computer.");
      return ensureFolderProjectOn(environmentId, folder, title, { ...options, providers });
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
   * `projectRef`: the folder's project, when the caller has just made it (New
   * folder… / Upload a folder… / Clone from GitHub…) — it may not be in the
   * store yet, and looking it up by path would make a second one.
   */
  const moveDraftToFolder = useCallback(
    async (
      draftId: DraftId,
      folder: string | null,
      projectRef?: ScopedProjectRef,
    ): Promise<void> => {
      if (environmentId === null) return;
      const target = folder ?? (await resolveHomeFolder(environmentId));
      if (!target) throw new Error("Couldn't find the home folder on this computer.");
      const carry = readDraftCarry(draftId);
      if (projectRef) await handleNewThread(projectRef, { envMode: "local" });
      else await chatInFolder(target, folder ? undefined : HOME_FOLDER_TITLE);
      applyDraftCarry(router, draftId, carry, { keepModel: true });
    },
    [chatInFolder, environmentId, handleNewThread, router],
  );

  return { ensureFolderProject, chatInFolder, chatInHomeFolder, moveDraftToFolder };
}

/**
 * A new chat on any connected computer — the draft screen's and Home's
 * "on [computer ▾]". The chat opens in `folder` there (the home folder when
 * null); `moveDraft` brings what was typed along from a draft on another
 * computer (not the model: the other computer may not have it).
 */
export function useChatOnComputer() {
  const { handleNewThread } = useNewThreadHandler();
  const router = useRouter();

  const chatIn = useCallback(
    async (environmentId: EnvironmentId, folder: string | null): Promise<ScopedProjectRef> => {
      const target = folder ?? (await resolveHomeFolder(environmentId));
      if (!target) throw new Error("Couldn't reach that computer.");
      const projectRef = await ensureFolderProjectOn(
        environmentId,
        target,
        folder ? undefined : HOME_FOLDER_TITLE,
      );
      await handleNewThread(projectRef, { envMode: "local" });
      return projectRef;
    },
    [handleNewThread],
  );

  const moveDraft = useCallback(
    async (draftId: DraftId, environmentId: EnvironmentId): Promise<void> => {
      const carry = readDraftCarry(draftId);
      await chatIn(environmentId, null);
      applyDraftCarry(router, draftId, carry, { keepModel: false });
    },
    [chatIn, router],
  );

  return { chatIn, moveDraft };
}
