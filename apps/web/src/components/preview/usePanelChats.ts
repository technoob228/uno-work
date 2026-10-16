/**
 * Names of the panel's levels for menus: the current project's name and, for
 * "In other chats", what each chat is called and which project it belongs to.
 * Read from the store when asked (menus are short-lived) — no subscription to
 * every thread of every computer.
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useSettings } from "../../hooks/useSettings";
import { deriveLogicalProjectKeyFromSettings } from "../../logicalProject";
import { selectProjectByRef, selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import type { PanelChatInfo } from "./panelTabs.logic";

export function useCurrentProjectName(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): string | null {
  return useStore((state) =>
    environmentId && projectId
      ? (selectProjectByRef(state, { environmentId, projectId })?.name ?? null)
      : null,
  );
}

/** `threadId → chat` over every computer, built on demand. */
export function usePanelChatDirectory(): () => (threadId: string) => PanelChatInfo | null {
  const grouping = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const mode = grouping.sidebarProjectGroupingMode;
  const overrides = grouping.sidebarProjectGroupingOverrides;
  return useCallback(() => {
    const state = useStore.getState();
    const settings = {
      sidebarProjectGroupingMode: mode,
      sidebarProjectGroupingOverrides: overrides,
    };
    const byId = new Map<string, PanelChatInfo>();
    for (const thread of selectSidebarThreadsAcrossEnvironments(state)) {
      if (thread.archivedAt) continue;
      const project = selectProjectByRef(state, {
        environmentId: thread.environmentId,
        projectId: thread.projectId,
      });
      byId.set(thread.id, {
        title: thread.title,
        projectKey: project ? deriveLogicalProjectKeyFromSettings(project, settings) : null,
        environmentId: thread.environmentId,
      });
    }
    return (threadId: string) => byId.get(threadId) ?? null;
  }, [mode, overrides]);
}
