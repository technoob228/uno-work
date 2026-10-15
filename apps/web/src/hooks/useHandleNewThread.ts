import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import {
  DEFAULT_RUNTIME_MODE,
  isAssistantProjectId,
  type EnvironmentId,
  type ModelSelection,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { deriveLogicalProjectKeyFromSettings, getProjectOrderKey } from "../logicalProject";
import { selectProjectsAcrossEnvironments, useStore } from "../store";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  readEnvironmentServerConfig,
  useEnvironmentProviders,
} from "../environments/settings/serverSettings";
import { newChatModelSelection } from "../components/computer/home/homeStartModel";
import { createStarterProject } from "../starterProject";
import { useDefaultEnvironment } from "./useDefaultEnvironment";
import { getClientSettings, useSettings } from "./useSettings";

/**
 * "New chats start on" (Settings → AI, Misha 15.10) for a new chat in
 * `projectRef`. Null when it isn't set or can't run on that computer: the chat
 * then starts on the last pick, as before. The assistant's chat never asks — it
 * runs on Hermes.
 */
function newChatStartSelection(projectRef: ScopedProjectRef): ModelSelection | null {
  if (isAssistantProjectId(projectRef.projectId)) return null;
  const config = readEnvironmentServerConfig(projectRef.environmentId);
  return newChatModelSelection({
    providers: config?.providers ?? [],
    settings: { ...DEFAULT_UNIFIED_SETTINGS, ...config?.settings, ...getClientSettings() },
  });
}

function useNewThreadState() {
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const {
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        getComposerDraft,
        applyStickyState,
        setModelSelection,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const startOn = newChatStartSelection(projectRef);
      const currentRouteTarget = getCurrentRouteTarget();
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.draftId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, storedDraftThread.draftId, {
            threadId: storedDraftThread.threadId,
          });
          // A kept draft nothing was typed into is still a new chat: it starts
          // on the chosen model too, not on whatever it was opened with. Not
          // the one on screen — a model just picked there stays.
          const kept = getComposerDraft(storedDraftThread.draftId);
          const onScreen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === storedDraftThread.draftId;
          if (
            startOn &&
            !onScreen &&
            (kept?.prompt.trim() ?? "") === "" &&
            (kept?.images.length ?? 0) === 0 &&
            (kept?.terminalContexts.length ?? 0) === 0
          ) {
            setModelSelection(storedDraftThread.draftId, startOn);
          }
          useStore.getState().setActiveEnvironmentId(projectRef.environmentId);
          if (
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === storedDraftThread.draftId
          ) {
            return;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: storedDraftThread.draftId },
          });
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null
      ) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(currentRouteTarget.draftId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
        });
        useStore.getState().setActiveEnvironmentId(projectRef.environmentId);
        return Promise.resolve();
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        applyStickyState(draftId);
        if (startOn) setModelSelection(draftId, startOn);
        useStore.getState().setActiveEnvironmentId(projectRef.environmentId);

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
        });
      })();
    },
    [getCurrentRouteTarget, projectGroupingSettings, router, projects],
  );
}

export function useNewThreadHandler() {
  const handleNewThread = useNewThreadState();

  return {
    handleNewThread,
  };
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const { defaultEnvironmentId } = useDefaultEnvironment();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const storeActiveEnvironmentId = useStore((store) => store.activeEnvironmentId);
  // The machine selected in the switcher; the primary one until something else is.
  const activeEnvironmentId = storeActiveEnvironmentId ?? primaryEnvironmentId ?? null;
  const activeEnvironmentProviders = useEnvironmentProviders(activeEnvironmentId);
  const addProjectBaseDirectory = useSettings(
    (settings) => settings.addProjectBaseDirectory?.trim() ?? "",
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadState();

  // With no project open, a new chat starts on the selected machine: its first
  // project in sidebar order. Only with no machine selected does the default
  // machine (then the first project anywhere) decide. A selected machine with
  // no project gets a starter project (`createStarterProject`) instead of the
  // chat silently opening on another machine.
  const realProjects = orderedProjects.filter((project) => !isAssistantProjectId(project.id));
  const defaultProject =
    activeEnvironmentId !== null
      ? realProjects.find((project) => project.environmentId === activeEnvironmentId)
      : ((defaultEnvironmentId
          ? realProjects.find((project) => project.environmentId === defaultEnvironmentId)
          : undefined) ?? realProjects[0]);

  const createStarterProjectOnMachine = useCallback(
    (environmentId: EnvironmentId) =>
      createStarterProject({
        environmentId,
        providers: environmentId === activeEnvironmentId ? activeEnvironmentProviders : [],
        baseDirectory: addProjectBaseDirectory,
      }),
    [activeEnvironmentId, activeEnvironmentProviders, addProjectBaseDirectory],
  );

  return {
    activeDraftThread,
    activeThread,
    activeEnvironmentId,
    createStarterProject: createStarterProjectOnMachine,
    defaultProjectRef: defaultProject
      ? scopeProjectRef(defaultProject.environmentId, defaultProject.id)
      : null,
    handleNewThread,
    routeThreadRef,
  };
}
