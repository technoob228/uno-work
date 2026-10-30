import { isAssistantProjectId } from "@t3tools/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useSettings } from "../../hooks/useSettings";
import { HOME_FOLDER_TITLE } from "../../lib/homeFolder";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import type { SettingsMachineOption } from "./useSettingsScope";

/** One entry per project across computers. The assistant's project and the home folder aren't ones a person sets. */
export function useSettingsProjectGroups(machines: ReadonlyArray<SettingsMachineOption>) {
  const projects = useStore(useShallow((store) => selectProjectsAcrossEnvironments(store)));
  const sidebarProjectGroupingMode = useSettings((settings) => settings.sidebarProjectGroupingMode);
  const sidebarProjectGroupingOverrides = useSettings(
    (settings) => settings.sidebarProjectGroupingOverrides,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(() => {
    const labels = new Map(machines.map((machine) => [machine.environmentId, machine.label]));
    return buildSidebarProjectSnapshots({
      projects: projects.filter(
        (project) => !isAssistantProjectId(project.id) && project.name !== HOME_FOLDER_TITLE,
      ),
      settings: { sidebarProjectGroupingMode, sidebarProjectGroupingOverrides },
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
    }).toSorted((a, b) => a.displayName.localeCompare(b.displayName));
  }, [
    machines,
    primaryEnvironmentId,
    projects,
    sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides,
  ]);
}
