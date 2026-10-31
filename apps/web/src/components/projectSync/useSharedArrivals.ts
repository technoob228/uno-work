/**
 * A project the person accepted comes to the computer they're looking at, as
 * the invitation promises, wherever they said Accept. It starts here and not
 * in the daemon: a cloud computer's daemon runs whether anyone is there or not,
 * and an open window the person isn't at shouldn't take it either. Which of
 * their computers gets it the daemons settle among themselves (`arrive`).
 *
 * @module projectSync/useSharedArrivals
 */
import type { EnvironmentId, ProjectSyncElsewhere } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { windowIsInFront } from "../../inbox/systemNotifications";
import { toastManager } from "../ui/toast";
import { arrivalWords, arrivalsToBring } from "./projectSync.logic";
import { useRefreshProjectSync } from "./useProjectSync";

/**
 * Once each while this window is open: what didn't come stays a row with Get
 * it here, and the same failure shouldn't repeat every 30 seconds.
 */
const tried = new Set<string>();

/** The team of the project on its way here now, for its row. */
export function useSharedArrivals(
  environmentId: EnvironmentId | null,
  projects: ReadonlyArray<ProjectSyncElsewhere>,
): number | null {
  const refresh = useRefreshProjectSync();
  const [arriving, setArriving] = useState<number | null>(null);
  const running = useRef(false);

  useEffect(() => {
    if (!environmentId) return;
    const bring = async (project: ProjectSyncElsewhere, teamId: number) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      setArriving(teamId);
      try {
        const result = await api.projectSync.arrive({ name: project.name, teamId });
        refresh(environmentId, result.entry);
        const words = arrivalWords(project.name, result.outcome, false);
        if (words) toastManager.add(words);
      } catch (error) {
        refresh(environmentId);
        toastManager.add({
          type: "error",
          title: `Couldn't get ${project.name}`,
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setArriving(null);
      }
    };
    const bringAll = async () => {
      if (running.current || !windowIsInFront()) return;
      running.current = true;
      try {
        for (const project of arrivalsToBring(environmentId, projects, tried)) {
          tried.add(project.tryKey);
          if (project.team) await bring(project, project.team.id);
        }
      } finally {
        running.current = false;
      }
    };
    void bringAll();
    const onReturn = () => void bringAll();
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [environmentId, projects, refresh]);

  return arriving;
}
