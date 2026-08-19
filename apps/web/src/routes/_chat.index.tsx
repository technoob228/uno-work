import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { isAssistantProjectId } from "@t3tools/contracts";

import { NoActiveThreadState } from "../components/NoActiveThreadState";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { useSavedEnvironmentRegistryStore } from "../environments/runtime";
import { APP_BASE_NAME, APP_DISPLAY_NAME } from "~/branding";
import { resolveDefaultLandingTarget } from "../defaultLanding";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { getProjectOrderKey } from "../logicalProject";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";

/**
 * Landing on "pick a thread to continue" makes the user choose before they can
 * do anything. Resume the most recent thread instead, or open a composer for
 * the most relevant project when there is nothing to resume.
 */
function useDefaultLandingRedirect(enabled: boolean) {
  const navigate = useNavigate();
  const { handleNewThread } = useNewThreadHandler();
  const activeEnvironmentId = useStore((store) => store.activeEnvironmentId);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const threads = useStore(useShallow((store) => selectSidebarThreadsAcrossEnvironments(store)));
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const hasRedirected = useRef(false);

  const target = useMemo(
    () =>
      resolveDefaultLandingTarget({
        threads,
        // The assistant's home project is a separate sidebar section, not
        // somewhere the user expects to land.
        projects: projects
          .filter((project) => !isAssistantProjectId(project.id))
          .map((project) => ({
            id: project.id,
            environmentId: project.environmentId,
            orderKey: getProjectOrderKey(project),
          })),
        activeEnvironmentId,
        projectOrder,
      }),
    [activeEnvironmentId, projectOrder, projects, threads],
  );

  useEffect(() => {
    if (!enabled || hasRedirected.current || target.kind === "empty") {
      return;
    }
    hasRedirected.current = true;

    if (target.kind === "thread") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: target.environmentId,
          threadId: target.threadId,
        }),
        replace: true,
      });
      return;
    }

    void handleNewThread(scopeProjectRef(target.environmentId, target.projectId)).catch(
      () => undefined,
    );
  }, [enabled, handleNewThread, navigate, target]);

  return target;
}

function ChatIndexRouteView() {
  const { authGateState } = Route.useRouteContext();
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );
  const needsEnvironment = authGateState.status === "hosted-static" && savedEnvironmentCount === 0;
  useDefaultLandingRedirect(!needsEnvironment);

  if (needsEnvironment) {
    return <HostedStaticOnboardingState />;
  }

  return <NoActiveThreadState />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});

function HostedStaticOnboardingState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
              {APP_DISPLAY_NAME}
            </span>
          </div>
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-xl rounded-3xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
            <EmptyHeader className="max-w-none">
              <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
                <LinkIcon className="size-5" />
              </div>
              <EmptyTitle className="text-foreground text-xl">
                Connect an environment to get started
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground/78">
                Open a pairing link from your {APP_BASE_NAME} desktop app or add a reachable backend
                manually. Your saved environments stay in this browser.
              </EmptyDescription>
              <div className="mt-6 flex justify-center">
                <Button render={<a href="/settings/connections" />} size="sm">
                  <PlusIcon className="size-4" />
                  Add environment
                </Button>
              </div>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
