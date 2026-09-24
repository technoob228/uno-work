/**
 * What the desktop's built-in programs do when clicked:
 *
 * - **Uno** — a new chat, exactly like "New chat" in the sidebar (last project
 *   on this machine, or a starter "Home" project on a fresh one);
 * - **Start a chat in a folder…** — the folder becomes a project (or is one
 *   already) and a new chat opens there;
 * - **Terminal** — a new chat with its terminal already open: Work's terminal
 *   belongs to a chat, so this is the shortest honest path to a shell.
 *
 * All of it goes through the existing orchestration commands
 * (`project.create`, the draft-thread machinery); nothing new on the server.
 */
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import {
  DEFAULT_MODEL,
  ProviderInstanceId,
  isAssistantProjectId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { ensureEnvironmentApi } from "../../environmentApi";
import { useEnvironmentProviders } from "../../environments/settings/serverSettings";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSettings } from "../../hooks/useSettings";
import { startNewLocalThreadFromContext } from "../../lib/chatThreadActions";
import { findProjectByPath, inferProjectTitleFromPath } from "../../lib/projectPaths";
import { newCommandId, newProjectId } from "../../lib/utils";
import { pickUsableDefaultModelSelection } from "../../providerModels";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { useTerminalStateStore } from "../../terminalStateStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { usePendingSendStore } from "./pendingSendStore";

export function useHomeLaunchers(environmentId: EnvironmentId | null) {
  const router = useRouter();
  const newThreadContext = useHandleNewThread();
  const defaultThreadEnvMode = useSettings((s) => s.defaultThreadEnvMode);
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const providers = useEnvironmentProviders(environmentId);
  const setTerminalOpen = useTerminalStateStore((store) => store.setTerminalOpen);

  const context = useCallback(
    () => ({
      activeDraftThread: null,
      activeThread: undefined,
      defaultProjectRef:
        newThreadContext.defaultProjectRef?.environmentId === environmentId
          ? newThreadContext.defaultProjectRef
          : null,
      defaultThreadEnvMode: "local" as const,
      handleNewThread: newThreadContext.handleNewThread,
      activeEnvironmentId: environmentId,
      createStarterProject: newThreadContext.createStarterProject,
      onMissingProject: openAddProject,
    }),
    [environmentId, newThreadContext, openAddProject],
  );

  const newChat = useCallback(async () => {
    await startNewLocalThreadFromContext({ ...context(), defaultThreadEnvMode });
  }, [context, defaultThreadEnvMode]);

  const openTerminalIn = useCallback(
    (started: boolean) => {
      if (!started) return;
      const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const target = resolveThreadRouteTarget(params);
      if (target?.kind === "draft") {
        const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
        if (draft) setTerminalOpen(scopeThreadRef(draft.environmentId, draft.threadId), true);
      } else if (target?.kind === "server") {
        setTerminalOpen(target.threadRef, true);
      }
    },
    [router, setTerminalOpen],
  );

  const chatInFolder = useCallback(
    async (folder: string, title?: string) => {
      if (environmentId === null) throw new Error("No connection to this computer.");
      const existing = findProjectByPath(
        projects.filter(
          (project) => project.environmentId === environmentId && !isAssistantProjectId(project.id),
        ),
        folder,
      );
      if (existing) {
        await newThreadContext.handleNewThread(scopeProjectRef(environmentId, existing.id), {
          envMode: "local",
        });
        return;
      }
      const selection = pickUsableDefaultModelSelection(providers);
      const projectId = newProjectId();
      await ensureEnvironmentApi(environmentId).orchestration.dispatchCommand({
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        title: title ?? inferProjectTitleFromPath(folder),
        workspaceRoot: folder,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: selection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        createdAt: new Date().toISOString(),
      });
      await newThreadContext.handleNewThread(scopeProjectRef(environmentId, projectId), {
        envMode: "local",
      });
    },
    [environmentId, newThreadContext, projects, providers],
  );

  /**
   * Terminal = a chat in the home folder with its terminal open: Work's
   * terminal belongs to a chat, and the home folder is where a person expects
   * a shell to start.
   */
  const openTerminal = useCallback(async () => {
    if (environmentId === null) return;
    let home: string | null = null;
    try {
      home = (await ensureEnvironmentApi(environmentId).filesystem.browse({ partialPath: "~" }))
        .parentPath;
    } catch {
      home = null;
    }
    if (home) {
      await chatInFolder(home, "Home folder");
      openTerminalIn(true);
      return;
    }
    openTerminalIn(await startNewLocalThreadFromContext(context()));
  }, [chatInFolder, context, environmentId, openTerminalIn]);

  /**
   * A new chat in `folder` (the home folder when absent) with `prompt` typed
   * into its composer. Returns the draft it opened, when it opened one.
   */
  const openChatWithPrompt = useCallback(
    async (prompt: string, folder?: string | null): Promise<DraftId | null> => {
      if (environmentId === null) return null;
      let target = folder ?? null;
      if (!target) {
        try {
          target = (
            await ensureEnvironmentApi(environmentId).filesystem.browse({ partialPath: "~" })
          ).parentPath;
        } catch {
          target = null;
        }
      }
      if (target) await chatInFolder(target, folder ? undefined : "Home folder");
      else await startNewLocalThreadFromContext(context());
      const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const route = resolveThreadRouteTarget(params);
      const store = useComposerDraftStore.getState();
      if (route?.kind === "draft") {
        store.setPrompt(route.draftId, prompt);
        return route.draftId;
      }
      if (route?.kind === "server") store.setPrompt(route.threadRef, prompt);
      return null;
    },
    [chatInFolder, context, environmentId, router],
  );

  /**
   * "Ask Uno": a new chat in the home folder with the note already typed in
   * the composer — the person reads it and presses Send.
   */
  const askUno = useCallback(
    async (prompt: string) => {
      await openChatWithPrompt(prompt);
    },
    [openChatWithPrompt],
  );

  /**
   * Home's composer: a new chat in `folder` (home by default) that sends the
   * task right away — the chat sends it itself once it has mounted (see
   * `pendingSendStore`). If it can't, the task stays typed there.
   */
  const startTask = useCallback(
    async (prompt: string, folder?: string | null) => {
      const draftId = await openChatWithPrompt(prompt, folder);
      if (draftId) usePendingSendStore.getState().request(draftId, prompt);
    },
    [openChatWithPrompt],
  );

  return { newChat, openTerminal, chatInFolder, askUno, startTask };
}
