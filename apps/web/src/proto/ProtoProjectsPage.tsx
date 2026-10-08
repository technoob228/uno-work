/**
 * Sidebar prototype (w0115, NOT FOR MERGE), variant E: projects are a place
 * like Files — one page with every project (empty ones too) and "New project";
 * the sidebar keeps only chats. "Show chats" narrows the sidebar list.
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import { FolderIcon, FolderPlusIcon, HomeIcon, MessageSquarePlusIcon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { isAssistantProjectId } from "@t3tools/contracts";
import { SidebarShowButton } from "../components/sidebar/SidebarShowButton";
import { Button } from "../components/ui/button";
import { SidebarInset, useSidebar } from "../components/ui/sidebar";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { openNewProject } from "../navigation/newProjectStore";
import {
  selectProjectsAcrossEnvironments,
  selectProjectsForEnvironment,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForEnvironment,
  useStore,
} from "../store";
import { NO_PROJECT } from "./ProtoSidebarList";
import { isHomeProject, machineLabel, projectKeyOf } from "./protoPlace";
import { useProtoAllMachines, useProtoStore } from "./protoState";

function agoLabel(ms: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function ProtoProjectsPage() {
  const joined = useProtoAllMachines();
  const setFilter = useProtoStore((state) => state.setFilter);
  const { isMobile, setOpenMobile } = useSidebar();
  const { handleNewThread } = useNewThreadHandler();
  const projects = useStore(
    useShallow((state) =>
      joined
        ? selectProjectsAcrossEnvironments(state)
        : selectProjectsForEnvironment(state, state.activeEnvironmentId),
    ),
  );
  const threads = useStore(
    useShallow((state) =>
      joined
        ? selectSidebarThreadsAcrossEnvironments(state)
        : selectSidebarThreadsForEnvironment(state, state.activeEnvironmentId),
    ),
  );
  const cards = useMemo(() => {
    const list = projects
      .filter((project) => !isAssistantProjectId(project.id))
      .map((project) => {
        const chats = threads.filter(
          (thread) =>
            thread.environmentId === project.environmentId &&
            thread.projectId === project.id &&
            thread.archivedAt === null,
        );
        const latest = Math.max(
          0,
          ...chats.map((thread) => Date.parse(thread.updatedAt ?? thread.createdAt)),
        );
        return { project, home: isHomeProject(project), chats, latest };
      });
    return list.toSorted(
      (a, b) => Number(b.home) - Number(a.home) || b.latest - a.latest,
    );
  }, [projects, threads]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="shrink-0 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-3">
            <SidebarShowButton />
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white">
              <FolderIcon className="size-4.5" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-semibold leading-tight">Projects</h1>
              <p className="truncate text-xs text-muted-foreground">
                A project is a folder for one piece of work — a site, a bot, a brand kit
              </p>
            </div>
            <Button size="sm" onClick={() => openNewProject()} data-testid="proto-page-new-project">
              <FolderPlusIcon />
              <span className="max-sm:hidden">New project</span>
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
          <div className="mx-auto grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map(({ project, home, chats, latest }) => (
              <div
                key={projectKeyOf(project)}
                className="flex min-w-0 flex-col gap-2 rounded-2xl border border-border/70 bg-card/40 p-4"
                data-testid="proto-project-card"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {home ? (
                    <HomeIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {home ? NO_PROJECT : project.name}
                  </span>
                  {joined ? (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {machineLabel(project.environmentId)}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {home
                    ? `${chats.length} chat${chats.length === 1 ? "" : "s"} that aren't in a project`
                    : chats.length === 0
                      ? "No chats yet"
                      : `${chats.length} chat${chats.length === 1 ? "" : "s"} · ${agoLabel(latest)}`}
                </p>
                <div className="mt-auto flex gap-1.5 pt-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={chats.length === 0}
                    onClick={() => {
                      setFilter(projectKeyOf(project));
                      if (isMobile) setOpenMobile(true);
                    }}
                  >
                    Show chats
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void handleNewThread(scopeProjectRef(project.environmentId, project.id))
                    }
                  >
                    <MessageSquarePlusIcon />
                    New chat
                  </Button>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={() => openNewProject()}
              className="flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <FolderPlusIcon className="size-5" />
              New project
              <span className="text-xs">Empty, from your computer, or from GitHub</span>
            </button>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
