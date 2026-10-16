/**
 * The current project's name, for the panel's tab groups and menus.
 */
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { selectProjectByRef, useStore } from "../../store";

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
