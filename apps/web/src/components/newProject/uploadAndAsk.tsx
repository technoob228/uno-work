/**
 * "Upload a project" from the start screen and from the console (`?do=upload`):
 * New project → Upload; once the project is on the computer, a chat in it
 * sends Uno a first task — look at it and offer to put it online.
 */
import { DEFAULT_RUNTIME_MODE } from "@t3tools/contracts";
import { useEffect } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { openNewProject } from "../../navigation/newProjectStore";
import type { ProjectUploadFile } from "../../projectUpload";
import { takeWorkIntent, uploadedProjectPrompt } from "../../unoai/workIntent";
import type { HomeStartOptions } from "../computer/home/HomeComposer";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";

type StartTask = (prompt: string, options: HomeStartOptions) => Promise<void>;

export function openUploadAndAsk(
  startTask: StartTask,
  files?: ReadonlyArray<ProjectUploadFile>,
): void {
  openNewProject("upload", {
    ...(files ? { files } : {}),
    afterUpload: ({ name, folder }) =>
      startTask(uploadedProjectPrompt(name, folder), {
        folder,
        modelSelection: null,
        runtimeMode: DEFAULT_RUNTIME_MODE,
      }),
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
