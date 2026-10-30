/**
 * What sync says unasked. The first project that saved by itself gets one
 * line with a way to its settings; projects from before sync was on by
 * default get one question, answered once for all computers. After that,
 * silence, except when someone else changed the same file as you.
 *
 * @module projectSync/ProjectSyncWelcome
 */
import type { EnvironmentId, ProjectId, ProjectSyncSnapshot } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { conflictLine, nameList } from "./projectSync.logic";
import { useRefreshProjectSync } from "./useProjectSync";

/** One line for the person, not one per computer. */
const INTRO_SHOWN_KEY = "uno:projectSyncIntroShown";

const introAlreadyShown = () => {
  try {
    return window.localStorage?.getItem(INTRO_SHOWN_KEY) === "1";
  } catch {
    return false;
  }
};
const rememberIntroShown = () => {
  try {
    window.localStorage?.setItem(INTRO_SHOWN_KEY, "1");
  } catch {
    // No storage: the daemon's note still keeps it to one per computer.
  }
};

type Statuses = ReadonlyArray<{
  environmentId: EnvironmentId;
  status: ProjectSyncSnapshot | undefined;
}>;

export function ProjectSyncWelcome(props: {
  statuses: Statuses;
  onOpenSettings: (environmentId: EnvironmentId, projectId: ProjectId) => void;
}) {
  const { statuses, onOpenSettings } = props;
  const refresh = useRefreshProjectSync();
  const introduced = useRef(new Set<EnvironmentId>());
  const toldConflicts = useRef(new Set<string>());
  const [answering, setAnswering] = useState(false);
  const [answered, setAnswered] = useState(false);

  useEffect(() => {
    for (const { environmentId, status } of statuses) {
      const intro = status?.intro;
      if (!intro || introduced.current.has(environmentId)) continue;
      introduced.current.add(environmentId);
      void readEnvironmentApi(environmentId)
        ?.projectSync.introSeen()
        .catch(() => undefined);
      if (introAlreadyShown()) continue;
      rememberIntroShown();
      toastManager.add({
        type: "info",
        title: "This project is saved and on all your computers.",
        actionProps: {
          children: "Settings",
          onClick: () => onOpenSettings(environmentId, intro.projectId),
        },
      });
    }
  }, [statuses, onOpenSettings]);

  useEffect(() => {
    for (const { environmentId, status } of statuses) {
      for (const entry of status?.projects ?? []) {
        const conflict = entry.conflict;
        const key = `${environmentId}:${entry.projectId}:${conflict?.at}`;
        if (!conflict?.person || toldConflicts.current.has(key)) continue;
        toldConflicts.current.add(key);
        toastManager.add({
          type: "warning",
          title: conflictLine(entry),
          actionProps: {
            children: "Bring mine back",
            onClick: () => {
              void readEnvironmentApi(environmentId)
                ?.projectSync.resolve({ projectId: entry.projectId, keep: "mine" })
                .then((next) => refresh(environmentId, next))
                .catch(() => onOpenSettings(environmentId, entry.projectId));
            },
          },
        });
      }
    }
  }, [statuses, onOpenSettings, refresh]);

  const asking = useMemo(
    () =>
      answered
        ? []
        : statuses.flatMap(({ environmentId, status }) =>
            (status?.askAbout?.length ?? 0) > 0 ? [environmentId] : [],
          ),
    [statuses, answered],
  );
  const names = useMemo(
    () => statuses.flatMap(({ status }) => (status?.askAbout ?? []).map((item) => item.title)),
    [statuses],
  );

  const answer = async (turnOn: boolean) => {
    setAnswering(true);
    await Promise.all(
      asking.map((environmentId) =>
        readEnvironmentApi(environmentId)
          ?.projectSync.answerOld({ turnOn })
          .catch(() => undefined),
      ),
    );
    for (const environmentId of asking) refresh(environmentId);
    setAnswered(true);
    setAnswering(false);
  };

  return (
    <Dialog open={asking.length > 0}>
      <DialogPopup className="max-w-md" showCloseButton={false} data-testid="project-sync-question">
        <DialogHeader>
          <DialogTitle>Keep your projects on all your computers?</DialogTitle>
          <DialogDescription>
            Uno can save versions of {nameList([...new Set(names)])} as you work, and keep them the
            same on every computer of yours. Keys stay out of them.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={answering} onClick={() => void answer(false)}>
            Not now
          </Button>
          <Button disabled={answering} onClick={() => void answer(true)}>
            Turn on
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
