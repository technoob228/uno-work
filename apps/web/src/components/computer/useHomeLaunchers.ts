/**
 * What the desktop's built-in programs do when clicked:
 *
 * - **Uno** — a new chat, exactly like "New chat" in the sidebar: in the home
 *   folder, with the folder chip on the chat to pick another one;
 * - **Start a chat in a folder…** — the folder becomes a project (or is one
 *   already) and a new chat opens there;
 * - **Terminal** — a new chat with its terminal already open: Work's terminal
 *   belongs to a chat, so this is the shortest honest path to a shell.
 *
 * All of it goes through the existing orchestration commands
 * (`project.create`, the draft-thread machinery); nothing new on the server.
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { HOME_FOLDER_TITLE, resolveHomeFolder, useFolderChats } from "../../hooks/useFolderChats";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSettings } from "../../hooks/useSettings";
import { startNewLocalThreadFromContext } from "../../lib/chatThreadActions";
import { useTerminalStateStore } from "../../terminalStateStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import type { HomeStartOptions } from "./home/HomeComposer";
import { usePendingSendStore } from "./pendingSendStore";

export function useHomeLaunchers(environmentId: EnvironmentId | null) {
  const router = useRouter();
  const newThreadContext = useHandleNewThread();
  const defaultThreadEnvMode = useSettings((s) => s.defaultThreadEnvMode);
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);
  const folderChats = useFolderChats(environmentId);
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

  /** New chat: the home folder; the old project-based path only if it can't be reached. */
  const newChat = useCallback(async () => {
    if (await folderChats.chatInHomeFolder()) return;
    await startNewLocalThreadFromContext({ ...context(), defaultThreadEnvMode });
  }, [context, defaultThreadEnvMode, folderChats]);

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
      await folderChats.chatInFolder(folder, title);
    },
    [folderChats],
  );

  /**
   * Terminal = a chat in the home folder with its terminal open: Work's
   * terminal belongs to a chat, and the home folder is where a person expects
   * a shell to start.
   */
  const openTerminal = useCallback(async () => {
    if (environmentId === null) return;
    const home = await resolveHomeFolder(environmentId);
    if (home) {
      await chatInFolder(home, HOME_FOLDER_TITLE);
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
      const target = folder || (await resolveHomeFolder(environmentId));
      if (target) await chatInFolder(target, folder ? undefined : HOME_FOLDER_TITLE);
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
   * Home's composer: a new chat in the chosen folder (home by default), on the
   * chosen model and permissions, that sends the task right away — the chat
   * sends it itself once it has mounted (see `pendingSendStore`). If it
   * can't, the task stays typed there.
   */
  const startTask = useCallback(
    async (prompt: string, options: HomeStartOptions) => {
      const draftId = await openChatWithPrompt(prompt, options.folder);
      if (!draftId) return;
      const store = useComposerDraftStore.getState();
      // Set on the draft itself: a reused draft doesn't pick up the sticky model.
      if (options.modelSelection) store.setModelSelection(draftId, options.modelSelection);
      store.setRuntimeMode(draftId, options.runtimeMode);
      store.setDraftThreadContext(draftId, { runtimeMode: options.runtimeMode });
      usePendingSendStore.getState().request(draftId, prompt);
    },
    [openChatWithPrompt],
  );

  return { newChat, openTerminal, chatInFolder, askUno, startTask };
}
