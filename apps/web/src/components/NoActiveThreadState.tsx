import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { isAssistantProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./ui/menu";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { isElectron } from "../env";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useReconnectEnvironment } from "../hooks/useReconnectEnvironment";
import { sortThreads } from "../lib/threadSort";
import { plainExplanation } from "../plainLanguage";
import {
  selectProjectsForEnvironment,
  selectSidebarThreadsForEnvironment,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { cn } from "~/lib/utils";
import { formatElapsedAgoLabel } from "../timestampFormat";
import { Explain } from "./Explain";

/** "A folder the agent works in." → "a folder the agent works in" for mid-sentence use. */
function asClause(sentence: string): string {
  return sentence.replace(/\.$/u, "").replace(/^./u, (first) => first.toLowerCase());
}

export function NoActiveThreadState() {
  const navigate = useNavigate();
  const activeEnvironmentId = useStore((store) => store.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const selectedEnvId = activeEnvironmentId ?? primaryEnvironmentId;

  const runtime = useSavedEnvironmentRuntimeStore((store) =>
    selectedEnvId ? store.byId[selectedEnvId] : undefined,
  );
  const registryRecord = useSavedEnvironmentRegistryStore((store) =>
    selectedEnvId ? store.byId[selectedEnvId] : undefined,
  );

  const connectionState = runtime?.connectionState ?? (registryRecord ? "disconnected" : undefined);
  const isEnvironmentUnavailable =
    registryRecord != null && connectionState !== undefined && connectionState !== "connected";
  const canReconnect =
    selectedEnvId != null &&
    isEnvironmentUnavailable &&
    (connectionState === "disconnected" || connectionState === "error");
  const isAutomaticallyReconnecting =
    connectionState === "connecting" || connectionState === "reconnecting";
  const envName = runtime?.descriptor?.label ?? registryRecord?.label ?? "this machine";
  const cachedChatStatus = runtime?.lastSynchronizedAt
    ? `Cached chats were last synchronized ${formatElapsedAgoLabel(runtime.lastSynchronizedAt)}.`
    : "No fresh chat snapshot has been received yet.";

  const { reconnect, reconnectingId } = useReconnectEnvironment();
  const isReconnecting = selectedEnvId != null && reconnectingId === selectedEnvId;
  const { handleNewThread } = useNewThreadHandler();
  const [isStartingChat, setIsStartingChat] = useState(false);

  // The assistant's home project is created automatically and lives in its own
  // sidebar section — counting it here would tell a user with an empty machine
  // to "pick a chat" instead of offering to add their first project.
  const projectsInEnv = useStore(
    useShallow((store) =>
      selectProjectsForEnvironment(store, selectedEnvId).filter(
        (project) => !isAssistantProjectId(project.id),
      ),
    ),
  );
  const threadsInEnv = useStore(
    useShallow((store) => selectSidebarThreadsForEnvironment(store, selectedEnvId)),
  );
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);

  const onReconnect = () => {
    if (selectedEnvId) void reconnect(selectedEnvId);
  };

  const singleProject = projectsInEnv.length === 1 ? projectsInEnv[0] : null;
  const activeThreads = useMemo(
    () =>
      sortThreads(
        threadsInEnv.filter((thread) => thread.archivedAt === null),
        "updated_at",
      ),
    [threadsInEnv],
  );
  const activeThreadsByProjectId = useMemo(() => {
    const next = new Map<string, SidebarThreadSummary[]>();
    for (const thread of activeThreads) {
      const existing = next.get(thread.projectId);
      if (existing) {
        existing.push(thread);
      } else {
        next.set(thread.projectId, [thread]);
      }
    }
    return next;
  }, [activeThreads]);
  const singleProjectThreads = singleProject
    ? (activeThreadsByProjectId.get(singleProject.id) ?? [])
    : [];
  const hasActiveThreads = activeThreads.length > 0;

  const openThread = (thread: SidebarThreadSummary) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };

  // "New chat" with no chats yet: open a composer in the only project, or in
  // the first one — the user can move to another project from the sidebar.
  const startFirstChat = async () => {
    const project = singleProject ?? projectsInEnv[0];
    if (!project || isStartingChat) return;
    setIsStartingChat(true);
    try {
      await handleNewThread(scopeProjectRef(project.environmentId, project.id));
    } catch {
      // The handler already surfaces failures through the composer's own error path.
    } finally {
      setIsStartingChat(false);
    }
  };

  const renderThreadItem = (thread: SidebarThreadSummary) => (
    <MenuItem key={thread.id} onClick={() => openThread(thread)}>
      <MessageSquareIcon className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      {thread.branch ? (
        <span className="max-w-24 truncate text-xs text-muted-foreground">#{thread.branch}</span>
      ) : null}
    </MenuItem>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              No chat open
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No chat open
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1">
          <div className="flex w-full max-w-lg flex-col items-center rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            {isEnvironmentUnavailable ? (
              <>
                <EmptyHeader className="max-w-none">
                  <EmptyTitle className="text-foreground text-xl">
                    {isAutomaticallyReconnecting
                      ? "Reconnecting to machine"
                      : "Machine disconnected"}
                  </EmptyTitle>
                  <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                    <span className="font-medium text-foreground">&ldquo;{envName}&rdquo;</span>{" "}
                    {isAutomaticallyReconnecting
                      ? "is reconnecting and checking its current chats."
                      : "must reconnect before its chats can be trusted."}{" "}
                    {cachedChatStatus}
                  </EmptyDescription>
                </EmptyHeader>
                {canReconnect || isAutomaticallyReconnecting ? (
                  <EmptyContent className="mt-6">
                    <Button
                      onClick={onReconnect}
                      disabled={isReconnecting || isAutomaticallyReconnecting}
                      size="sm"
                    >
                      <RefreshCwIcon
                        className={cn(
                          "size-4",
                          (isReconnecting || isAutomaticallyReconnecting) && "animate-spin",
                        )}
                      />
                      {isReconnecting || isAutomaticallyReconnecting
                        ? "Reconnecting..."
                        : "Reconnect"}
                    </Button>
                  </EmptyContent>
                ) : null}
              </>
            ) : projectsInEnv.length === 0 ? (
              <>
                <EmptyHeader className="max-w-none">
                  <EmptyTitle className="inline-flex items-center gap-2 text-foreground text-xl">
                    No projects yet
                    <Explain term="project" />
                  </EmptyTitle>
                  <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                    A project is {asClause(plainExplanation("project"))}. Add one on{" "}
                    <span className="font-medium text-foreground">&ldquo;{envName}&rdquo;</span> to
                    start your first chat.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="mt-6">
                  <Button onClick={openAddProject} size="sm">
                    <FolderPlusIcon className="size-4" />
                    Add project
                  </Button>
                </EmptyContent>
              </>
            ) : !hasActiveThreads ? (
              <>
                <EmptyHeader className="max-w-none">
                  <EmptyTitle className="inline-flex items-center gap-2 text-foreground text-xl">
                    No chats yet
                    <Explain term="chat" technical />
                  </EmptyTitle>
                  <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                    A chat is {asClause(plainExplanation("chat"))}. Start one in{" "}
                    <span className="font-medium text-foreground">
                      {singleProject ? singleProject.name : (projectsInEnv[0]?.name ?? "a project")}
                    </span>{" "}
                    and tell the agent what you need.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="mt-6">
                  <Button onClick={() => void startFirstChat()} size="sm" disabled={isStartingChat}>
                    <MessageSquarePlusIcon className="size-4" />
                    New chat
                  </Button>
                </EmptyContent>
              </>
            ) : (
              <>
                <EmptyHeader className="max-w-none">
                  <EmptyTitle className="text-foreground text-xl">
                    Pick a chat to continue
                  </EmptyTitle>
                  <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                    Open one of your chats, or start a new one from the sidebar.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="mt-6">
                  {singleProject ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button size="sm">
                            <MessageSquareIcon className="size-4" />
                            Pick a chat
                            <ChevronDownIcon className="size-3.5 opacity-70" />
                          </Button>
                        }
                      />
                      <MenuPopup align="center" side="bottom" sideOffset={6} className="min-w-72">
                        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                          {singleProject.name}
                        </div>
                        {singleProjectThreads.map(renderThreadItem)}
                      </MenuPopup>
                    </Menu>
                  ) : (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button size="sm">
                            <MessageSquareIcon className="size-4" />
                            Pick a chat
                            <ChevronDownIcon className="size-3.5 opacity-70" />
                          </Button>
                        }
                      />
                      <MenuPopup align="center" side="bottom" sideOffset={6} className="min-w-64">
                        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                          Pick a project
                        </div>
                        {projectsInEnv.map((project) => {
                          const projectThreads = activeThreadsByProjectId.get(project.id) ?? [];
                          if (projectThreads.length === 0) {
                            return null;
                          }
                          return (
                            <MenuSub key={project.id}>
                              <MenuSubTrigger>
                                <FolderIcon className="size-3.5 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                              </MenuSubTrigger>
                              <MenuSubPopup className="min-w-72">
                                {projectThreads.map(renderThreadItem)}
                              </MenuSubPopup>
                            </MenuSub>
                          );
                        })}
                      </MenuPopup>
                    </Menu>
                  )}
                </EmptyContent>
              </>
            )}
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
