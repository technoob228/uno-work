/**
 * The folder chip on a new chat that hasn't been sent yet: "Home folder ▾"
 * (or the folder's name). Picking another folder moves the chat there with
 * what was typed — a new chat always starts right away in the home folder,
 * and this is the one click to work somewhere else.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { memo } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useFolderChats, useHomeFolderPath } from "../../hooks/useFolderChats";
import { normalizeProjectPathForComparison } from "../../lib/projectPaths";
import { FolderChipMenu } from "../computer/FolderChipMenu";
import { toastManager } from "../ui/toast";

export const DraftFolderChip = memo(function DraftFolderChip({
  environmentId,
  draftId,
  projectName,
  projectCwd,
}: {
  environmentId: EnvironmentId;
  draftId: DraftId;
  projectName: string;
  projectCwd: string;
}) {
  const home = useHomeFolderPath(environmentId);
  const { moveDraftToFolder } = useFolderChats(environmentId);
  const inHome =
    home !== null &&
    normalizeProjectPathForComparison(home) === normalizeProjectPathForComparison(projectCwd);
  return (
    <FolderChipMenu
      environmentId={environmentId}
      folder={inHome ? null : { cwd: projectCwd, name: projectName }}
      className="h-6 shrink-0"
      testId="draft-folder-chip"
      onPick={(next) => {
        if (next === null ? inHome : next.cwd === projectCwd) return;
        moveDraftToFolder(draftId, next?.cwd ?? null).catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Couldn't switch the folder",
            description: error instanceof Error ? error.message : String(error),
          });
        });
      }}
    />
  );
});
