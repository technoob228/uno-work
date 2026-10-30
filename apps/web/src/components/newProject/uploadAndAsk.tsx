/**
 * "Upload a project" from the start screen and from the console (`?do=upload`):
 * New project → Upload; once the project is on the computer, a chat in it
 * sends Uno a first task — look at it and offer to put it online.
 */
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { openNewProject } from "../../navigation/newProjectStore";
import type { ProjectUploadFile } from "../../projectUpload";
import { takeWorkIntent, uploadedProjectPrompt } from "../../unoai/workIntent";
import type { HomeStartOptions } from "../computer/home/HomeComposer";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import { describedProjectPrompt, notUploadedLines } from "./newProject.logic";

type StartTask = (prompt: string, options: HomeStartOptions) => Promise<void>;

export function openUploadAndAsk(
  startTask: StartTask,
  files?: ReadonlyArray<ProjectUploadFile>,
): void {
  openNewProject("upload", {
    ...(files ? { files } : {}),
    afterCreate: ({ name, folder, about, contents, notUploaded }) =>
      startTask(
        // Nothing to look at or publish yet: start from what they said.
        about && contents === "none"
          ? describedProjectPrompt({ name, folder, about, contents })
          : [
              uploadedProjectPrompt(name, folder),
              ...(about ? [`About it, in my words: ${about}`] : []),
              // Part of the upload didn't fit: Uno says so first (Misha 20.10).
              ...(notUploaded && notUploaded.files > 0 ? [notUploadedLines(notUploaded)] : []),
            ].join("\n\n"),
        { folder, modelSelection: null, runtimeMode: null },
      ),
  });
}

/**
 * The console's `?do=upload`, wherever the app opened (Home, the last chat):
 * mounted once next to the New project dialog.
 */
export function WorkIntentBridge() {
  const environmentId = usePrimaryEnvironmentId();
  const { startTask } = useHomeLaunchers(environmentId);
  useEffect(() => {
    if (environmentId === null) return;
    if (takeWorkIntent() === "upload") openUploadAndAsk(startTask);
  }, [environmentId, startTask]);
  return null;
}
