/**
 * Loom Work wired to the real app: the browser's media APIs, the chat's
 * computer (staging, Drive, the gateway via the daemon) and toasts.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { filesApi } from "../components/files/filesApi";
import { toastManager } from "../components/ui/toast";
import { ensureEnvironmentApi } from "../environmentApi";
import { isElectron } from "../env";
import { randomUUID } from "../lib/utils";
import type { PipelineDeps } from "./pipeline";
import { browserRecorderEnv } from "./recorder";
import { configureRecordingRuntime } from "./recordingStore";

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform || navigator.userAgent || "");
}

export function realPipelineDeps(environmentId: string): PipelineDeps {
  const id = environmentId as EnvironmentId;
  let home: Promise<string> | null = null;
  return {
    homePath: () => {
      home ??= filesApi(id)
        .list({ showHidden: false })
        .then((listing) => listing.rootPath);
      return home;
    },
    writeFile: (input) => ensureEnvironmentApi(id).projects.writeFile(input),
    driveState: async () => {
      const state = await filesApi(id).driveState();
      return {
        available: state.available,
        message: state.message,
        bucketId: state.bucketId,
        usedBytes: state.usedBytes,
        quotaBytes: state.quotaBytes,
      };
    },
    copyToCloud: (input) => filesApi(id).cloudCopyToCloud(input),
    shareCreate: (input) =>
      filesApi(id).driveShareCreate({
        key: input.key,
        ...(input.expiresInHours !== undefined ? { expiresInHours: input.expiresInHours } : {}),
      }),
    describe: async (input) => {
      const media = ensureEnvironmentApi(id).media;
      if (!media) throw new Error("This computer can't watch recordings yet — update Uno Work.");
      return media.describeVideo(input);
    },
    removePaths: (paths) => filesApi(id).delete({ paths }),
    deleteCloud: (input) => filesApi(id).cloudDelete(input),
  };
}

let configured = false;

export function ensureRecordingRuntime() {
  if (configured) return;
  configured = true;
  configureRecordingRuntime({
    env: () => browserRecorderEnv({ mac: isMac(), desktopApp: isElectron }),
    deps: realPipelineDeps,
    notify: (notice) =>
      toastManager.add({
        type: notice.kind === "info" ? "info" : notice.kind,
        title: notice.title,
        ...(notice.description ? { description: notice.description } : {}),
      }),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    newId: () => randomUUID(),
    now: () => new Date(),
  });
}

/** Lets the demo build answer the computer itself (VITE_DEMO). */
export function overrideRecordingDeps(deps: (environmentId: string) => PipelineDeps) {
  configured = true;
  configureRecordingRuntime({
    env: () => browserRecorderEnv({ mac: isMac(), desktopApp: isElectron }),
    deps,
    notify: (notice) =>
      toastManager.add({
        type: notice.kind === "info" ? "info" : notice.kind,
        title: notice.title,
        ...(notice.description ? { description: notice.description } : {}),
      }),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    newId: () => randomUUID(),
    now: () => new Date(),
  });
}
