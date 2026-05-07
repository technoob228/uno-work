import { scopeProjectRef } from "@t3tools/client-runtime";
import type { ProjectId } from "@t3tools/contracts";
import { ChevronDownIcon, FolderIcon, FolderPlusIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
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
import { selectProjectsForEnvironment, useStore } from "../store";
import { cn } from "~/lib/utils";

export function NoActiveThreadState() {
  const activeEnvironmentId = useStore((store) => store.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const selectedEnvId = activeEnvironmentId ?? primaryEnvironmentId;

  const runtime = useSavedEnvironmentRuntimeStore((store) =>
    selectedEnvId ? store.byId[selectedEnvId] : undefined,
  );
  const registryRecord = useSavedEnvironmentRegistryStore((store) =>
    selectedEnvId ? store.byId[selectedEnvId] : undefined,
  );

  const connectionState = runtime?.connectionState;
  const canReconnect =
    selectedEnvId != null &&
    registryRecord != null &&
    (connectionState === "disconnected" || connectionState === "error");
  const envName = runtime?.descriptor?.label ?? registryRecord?.label ?? "this environment";

  const { reconnect, reconnectingId } = useReconnectEnvironment();
  const isReconnecting = selectedEnvId != null && reconnectingId === selectedEnvId;

  const projectsInEnv = useStore(
    useShallow((store) => selectProjectsForEnvironment(store, selectedEnvId)),
  );
  const { handleNewThread } = useNewThreadHandler();
  const openAddProject = useCommandPaletteStore((store) => store.openAddProject);

  const onReconnect = () => {
    if (selectedEnvId) void reconnect(selectedEnvId);
  };

  const startThreadInProject = (projectId: ProjectId) => {
    if (!selectedEnvId) return;
    void handleNewThread(scopeProjectRef(selectedEnvId, projectId));
  };

  const singleProject = projectsInEnv.length === 1 ? projectsInEnv[0] : null;

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
              No active thread
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-lg rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            {canReconnect ? (
              <>
                <EmptyHeader className="max-w-none">
                  <EmptyTitle className="text-foreground text-xl">
                    Environment disconnected
                  </EmptyTitle>
                  <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                    Reconnect{" "}
                    <span className="font-medium text-foreground">&ldquo;{envName}&rdquo;</span> to
                    load threads.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="mt-6">
                  <Button onClick={onReconnect} disabled={isReconnecting} size="sm">
                    <RefreshCwIcon className={cn("size-4", isReconnecting && "animate-spin")} />
                    {isReconnecting ? "Reconnecting..." : "Reconnect"}
                  </Button>
                </EmptyContent>
              </>
            ) : projectsInEnv.length === 0 ? (
              <>
                <EmptyHeader className="max-w-none">
                  <EmptyTitle className="text-foreground text-xl">
                    No projects in this environment
                  </EmptyTitle>
                  <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                    Add a project folder to{" "}
                    <span className="font-medium text-foreground">&ldquo;{envName}&rdquo;</span> to
                    start a thread.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="mt-6">
                  <Button onClick={openAddProject} size="sm">
                    <FolderPlusIcon className="size-4" />
                    Add project
                  </Button>
                </EmptyContent>
              </>
            ) : (
              <>
                <EmptyHeader className="max-w-none">
                  <EmptyTitle className="text-foreground text-xl">
                    Pick a thread to continue
                  </EmptyTitle>
                  <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                    Select an existing thread or create a new one to get started.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent className="mt-6">
                  {singleProject ? (
                    <Button onClick={() => startThreadInProject(singleProject.id)} size="sm">
                      <PlusIcon className="size-4" />
                      New thread in <span className="font-medium">{singleProject.name}</span>
                    </Button>
                  ) : (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button size="sm">
                            <PlusIcon className="size-4" />
                            New thread
                            <ChevronDownIcon className="size-3.5 opacity-70" />
                          </Button>
                        }
                      />
                      <MenuPopup align="center" side="bottom" sideOffset={6} className="min-w-56">
                        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                          Pick a project
                        </div>
                        {projectsInEnv.map((project) => (
                          <MenuItem
                            key={project.id}
                            onClick={() => startThreadInProject(project.id)}
                          >
                            <FolderIcon className="size-3.5 text-muted-foreground" />
                            <span className="truncate">{project.name}</span>
                          </MenuItem>
                        ))}
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
