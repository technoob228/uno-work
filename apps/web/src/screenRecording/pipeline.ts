/**
 * After Stop (Loom Work): two independent steps, each with its own Retry.
 *
 * - **Save** — the video goes to Uno Drive `Recordings/`: staged on the chat's
 *   computer (chunked `projects.writeFile`, like chat uploads), moved into the
 *   Drive bucket (`files.cloud.copyToCloud` with removeSource), then a share
 *   link. Drive's free space is checked first.
 * - **Watch** — the small agent copy (5-minute parts) is staged too. One part:
 *   the daemon sends it to the gateway's `/video/describe` (speech + what was
 *   on screen). Several (a recording over 5 minutes, up to 60): the parts go
 *   to Uno Drive (`Recordings/.agent-<id>/`), the gateway reads them there
 *   (`/video/describe/drive`) and glues the answer; the parts are deleted after.
 *
 * The browser keeps the recording in memory until the card is sent or
 * removed, so a Retry never needs the person to record again.
 */
import type { ProjectUploadWriteInput } from "../projectUpload";
import { uploadFilesIntoDirectory } from "../projectUpload";
import {
  AGENT_COPY_MAX_BYTES,
  RECORDING_MAX_MS,
  agentPartsDrivePrefix,
  RECORDINGS_FOLDER,
  RECORDING_STAGING_DIR,
  driveSpaceProblem,
  extensionForMime,
  recordingDriveKey,
} from "./recordingLogic";

export type StepStatus = "waiting" | "running" | "done" | "failed" | "skipped";

export interface SaveStep {
  readonly status: StepStatus;
  /** 0..1 of the bytes sent to the computer. */
  readonly progress: number;
  readonly error: string | null;
  readonly driveKey: string | null;
  readonly shareUrl: string | null;
}

export interface WatchStep {
  readonly status: StepStatus;
  readonly error: string | null;
  readonly speech: string;
  readonly visual: string;
}

export interface RecordingItem {
  readonly id: string;
  /** The chat (thread id) the card belongs to. */
  readonly threadKey: string;
  readonly environmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly durationMs: number;
  readonly blob: Blob;
  readonly previewUrl: string;
  /** The agent copy in self-contained parts (recorder.ts AGENT_PART_MS). */
  readonly agentParts: ReadonlyArray<{ readonly blob: Blob; readonly durationMs: number }>;
  readonly agentCopyMimeType: string | null;
  readonly hasVoice: boolean;
  readonly createdAt: string;
  readonly save: SaveStep;
  readonly watch: WatchStep;
  /** The words were put into the box once (not again after the person edits). */
  readonly prefilled: boolean;
}

export interface DriveInfo {
  readonly available: boolean;
  readonly message: string | null;
  readonly bucketId: number | null;
  readonly usedBytes: number;
  readonly quotaBytes: number;
}

export interface PipelineDeps {
  /** The computer's home folder, absolute (`/home/me`). */
  readonly homePath: () => Promise<string>;
  readonly writeFile: (input: ProjectUploadWriteInput) => Promise<unknown>;
  readonly driveState: () => Promise<DriveInfo>;
  readonly copyToCloud: (input: {
    paths: string[];
    bucketId: number;
    prefix: string;
    removeSource: boolean;
  }) => Promise<{ files: number; skipped: ReadonlyArray<{ name: string; reason: string }> }>;
  readonly shareCreate: (input: {
    key: string;
    expiresInHours?: number;
  }) => Promise<{ url: string | null }>;
  readonly describe: (input: {
    path?: string;
    driveParts?: Array<{ key: string; durationSec: number }>;
    mimeType: string;
    durationSec: number;
  }) => Promise<{ speech: string; visual: string }>;
  readonly removePaths: (paths: string[]) => Promise<unknown>;
  /** Deletes a key or a folder prefix ("…/") from a bucket. */
  readonly deleteCloud: (input: { bucketId: number; key: string }) => Promise<unknown>;
}

export const INITIAL_SAVE: SaveStep = {
  status: "waiting",
  progress: 0,
  error: null,
  driveKey: null,
  shareUrl: null,
};

export const INITIAL_WATCH: WatchStep = { status: "waiting", error: null, speech: "", visual: "" };

function errorText(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Stopped.";
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return fallback;
}

function joinPath(base: string, rel: string): string {
  return `${base.replace(/\/+$/, "")}/${rel}`;
}

async function stageBlob(
  deps: PipelineDeps,
  home: string,
  relativePath: string,
  blob: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const result = await uploadFilesIntoDirectory(
    { writeFile: deps.writeFile },
    {
      targetDir: home,
      files: [{ relativePath, size: blob.size, blob }],
      filterIgnored: false,
      onProgress: (progress) =>
        onProgress(progress.totalBytes > 0 ? progress.sentBytes / progress.totalBytes : 1),
      ...(signal ? { signal } : {}),
    },
  );
  if (result.uploadedFiles !== 1) throw new Error("Couldn't copy the recording to the computer.");
  return joinPath(home, relativePath);
}

export function stagingRelativeDir(itemId: string): string {
  return `${RECORDING_STAGING_DIR}/${itemId}`;
}

/** Save: the video into Uno Drive `Recordings/` and a share link. */
export async function runSave(
  item: RecordingItem,
  deps: PipelineDeps,
  patch: (save: Partial<SaveStep>) => void,
  signal?: AbortSignal,
): Promise<void> {
  patch({ status: "running", progress: 0, error: null });
  let stagedPath: string | null = null;
  try {
    const drive = await deps.driveState();
    const problem = driveSpaceProblem(drive, item.sizeBytes);
    if (problem) throw new Error(problem);
    if (drive.bucketId === null)
      throw new Error("Uno Drive isn't ready yet. Try again in a minute.");
    const home = await deps.homePath();
    stagedPath = await stageBlob(
      deps,
      home,
      `${stagingRelativeDir(item.id)}/${item.name}`,
      item.blob,
      (fraction) => patch({ progress: Math.min(0.95, fraction * 0.95) }),
      signal,
    );
    const copied = await deps.copyToCloud({
      paths: [stagedPath],
      bucketId: drive.bucketId,
      prefix: RECORDINGS_FOLDER,
      removeSource: true,
    });
    if (copied.files < 1) {
      const why = copied.skipped[0]?.reason;
      throw new Error(
        why ? `Uno Drive didn't take it: ${why}.` : "Uno Drive didn't take the recording.",
      );
    }
    stagedPath = null;
    const driveKey = recordingDriveKey(item.name);
    patch({ progress: 0.98, driveKey });
    // A link is a nice-to-have: the file is safe in Drive even if it fails.
    let shareUrl: string | null = null;
    try {
      shareUrl = (await deps.shareCreate({ key: driveKey })).url || null;
    } catch {
      shareUrl = null;
    }
    patch({ status: "done", progress: 1, driveKey, shareUrl, error: null });
  } catch (error) {
    if (stagedPath) await deps.removePaths([stagedPath]).catch(() => undefined);
    patch({
      status: "failed",
      error: errorText(error, "Couldn't save the recording to Uno Drive."),
    });
  }
}

/** Why the agent copy can't be watched, or null. */
export function watchSkipReason(
  item: Pick<RecordingItem, "agentParts" | "durationMs">,
): string | null {
  if (item.agentParts.length === 0) {
    return "This browser couldn't make the small copy the agent watches.";
  }
  if (item.agentParts.some((part) => part.blob.size > AGENT_COPY_MAX_BYTES)) {
    return "The recording is too big for the agent to watch.";
  }
  if (item.durationMs > RECORDING_MAX_MS + 5_000) {
    return "Recordings up to 60 minutes can be watched.";
  }
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Watch: the agent copy → speech + what was on screen. */
export async function runWatch(
  item: RecordingItem,
  deps: PipelineDeps,
  patch: (watch: Partial<WatchStep>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const skip = watchSkipReason(item);
  if (skip) {
    patch({ status: "skipped", error: skip });
    return;
  }
  patch({ status: "running", error: null });
  const mime = item.agentCopyMimeType ?? item.mimeType;
  const ext = extensionForMime(mime);
  const staged: string[] = [];
  let driveFolder: { bucketId: number; key: string } | null = null;
  try {
    const home = await deps.homePath();
    if (item.agentParts.length === 1) {
      const part = item.agentParts[0]!;
      const path = await stageBlob(
        deps,
        home,
        `${stagingRelativeDir(item.id)}/agent-copy.${ext}`,
        part.blob,
        () => undefined,
        signal,
      );
      staged.push(path);
      const result = await deps.describe({
        path,
        mimeType: mime,
        durationSec: Math.max(1, Math.round(item.durationMs / 1000)),
      });
      patch({ status: "done", speech: result.speech, visual: result.visual, error: null });
      return;
    }
    // A long recording: its parts through Uno Drive.
    const drive = await deps.driveState();
    const partsBytes = item.agentParts.reduce((sum, part) => sum + part.blob.size, 0);
    const problem = driveSpaceProblem(drive, partsBytes);
    if (problem) throw new Error(`The agent watches long recordings through Uno Drive. ${problem}`);
    if (drive.bucketId === null)
      throw new Error("Uno Drive isn't ready yet. Try again in a minute.");
    const names = item.agentParts.map((_, index) => `part-${pad2(index + 1)}.${ext}`);
    for (const [index, part] of item.agentParts.entries()) {
      staged.push(
        await stageBlob(
          deps,
          home,
          `${stagingRelativeDir(item.id)}/agent/${names[index]}`,
          part.blob,
          () => undefined,
          signal,
        ),
      );
    }
    const prefix = agentPartsDrivePrefix(item.id);
    driveFolder = { bucketId: drive.bucketId, key: prefix };
    const copied = await deps.copyToCloud({
      paths: [...staged],
      bucketId: drive.bucketId,
      prefix,
      removeSource: true,
    });
    staged.length = 0;
    if (copied.files < item.agentParts.length) {
      throw new Error("Uno Drive didn't take the parts the agent watches.");
    }
    const result = await deps.describe({
      driveParts: item.agentParts.map((part, index) => ({
        key: `${prefix}${names[index]}`,
        durationSec: Math.max(1, Math.round(part.durationMs / 1000)),
      })),
      mimeType: mime,
      durationSec: Math.max(1, Math.round(item.durationMs / 1000)),
    });
    patch({ status: "done", speech: result.speech, visual: result.visual, error: null });
  } catch (error) {
    patch({ status: "failed", error: errorText(error, "The agent couldn't watch the recording.") });
  } finally {
    if (staged.length > 0) await deps.removePaths(staged).catch(() => undefined);
    if (driveFolder) await deps.deleteCloud(driveFolder).catch(() => undefined);
  }
}

/** Both steps side by side; the staging folder is removed after both. */
export async function runPipeline(
  item: RecordingItem,
  deps: PipelineDeps,
  patch: (update: { save?: Partial<SaveStep>; watch?: Partial<WatchStep> }) => void,
  signal?: AbortSignal,
): Promise<void> {
  await Promise.all([
    runSave(item, deps, (save) => patch({ save }), signal),
    runWatch(item, deps, (watch) => patch({ watch }), signal),
  ]);
  await cleanupStaging(item, deps);
}

export async function cleanupStaging(item: Pick<RecordingItem, "id">, deps: PipelineDeps) {
  try {
    const home = await deps.homePath();
    await deps.removePaths([joinPath(home, stagingRelativeDir(item.id))]);
  } catch {
    // best effort: an empty hidden folder is harmless
  }
}

/** The card can go with the message: saved (or the person accepts a failed save) and watched or skipped. */
export function recordingReadiness(item: RecordingItem): {
  readonly ready: boolean;
  readonly busy: boolean;
  readonly blocking: string | null;
} {
  const busy =
    item.save.status === "running" ||
    item.save.status === "waiting" ||
    item.watch.status === "running" ||
    item.watch.status === "waiting";
  if (busy) {
    return {
      ready: false,
      busy: true,
      blocking:
        item.watch.status === "running" || item.watch.status === "waiting"
          ? "Wait until the agent has watched the recording."
          : "Wait until the recording is saved to Uno Drive.",
    };
  }
  if (item.save.status === "failed" && item.watch.status !== "done") {
    return {
      ready: false,
      busy: false,
      blocking: "The recording wasn't saved or watched. Retry, or remove it.",
    };
  }
  return { ready: true, busy: false, blocking: null };
}
