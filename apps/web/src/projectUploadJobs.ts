/**
 * Folder uploads of "New project" that live on their own (Misha 20.10: "put it
 * uploading, closed the dialog, did other things, came back to the progress").
 *
 * - The upload belongs to this store, not to the dialog: closing the dialog or
 *   Cancel never stops it — only "Stop upload" does.
 * - Progress (bytes, files, speed, time left) is here for the dialog and for
 *   the small panel in the corner of Work (`ProjectUploadsPanel`).
 * - Stop / a failure keep what is already on the computer: Resume sends only
 *   the files that are not there yet (a half-sent file starts over).
 * - The job is saved in IndexedDB as it goes (which files are done, and the
 *   folder handle when the browser gives one). After the tab or the app is
 *   closed, Work offers Resume: the browser asks to see the folder again (or
 *   the person picks it again) and only the rest goes.
 */
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { create } from "zustand";

import { stripSharedTopFolder } from "./components/setup/goals";
import { ensureEnvironmentApi } from "./environmentApi";
import {
  PROJECT_UPLOAD_PARALLEL_FILES,
  computerUploadDeps,
  isNotEnoughSpaceError,
  uploadFilesIntoDirectory,
  type ProjectUploadFile,
} from "./projectUpload";
import {
  chooseFolderForProjectUpload,
  readDirectoryHandle,
  type FileSystemDirectoryHandleLike,
  type ReadFolder,
} from "./projectUploadPickers";
import type { ProgressSample } from "./projectUploadSummary";

export type ProjectUploadStatus =
  | "uploading"
  | "stopped"
  | "failed"
  | "done"
  /** Found after a reload: the tab or the app was closed mid-upload. */
  | "interrupted";

export interface ProjectUploadJob {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  /** The project's name (`~/projects/<name>`). */
  readonly name: string;
  /** The picked folder's own name on the laptop (to check a re-pick). */
  readonly sourceName: string;
  readonly target: string;
  /** `~/projects/luckyip` for display. */
  readonly targetLabel: string;
  readonly projectRef: ScopedProjectRef;
  readonly status: ProjectUploadStatus;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly completedFiles: number;
  readonly sentBytes: number;
  readonly samples: ReadonlyArray<ProgressSample>;
  readonly error: string | null;
  /** The dialog is showing this upload (it opens the project itself when done). */
  readonly attached: boolean;
  /** Resume after a reload can ask the browser for the same folder (no re-pick). */
  readonly hasHandle: boolean;
}

/** What only this tab holds: the files, the stop button, what happens at the end. */
interface JobRuntime {
  files: ReadonlyArray<ProjectUploadFile> | null;
  readonly skipFolders: ReadonlyMap<string, string>;
  readonly completed: Set<string>;
  controller: AbortController | null;
  /** The dialog's ending (first message, the chat chip's move…); else just open it. */
  readonly onFinished: (() => Promise<void>) | null;
  /** Written into the project at the end: what didn't come and why. */
  readonly leftOut: { readonly fileName: string; readonly text: string } | null;
  handle: FileSystemDirectoryHandleLike | null;
}

interface ProjectUploadsState {
  readonly jobs: ReadonlyArray<ProjectUploadJob>;
}

export const useProjectUploads = create<ProjectUploadsState>(() => ({ jobs: [] }));

const runtimes = new Map<string, JobRuntime>();
const SAMPLE_LIMIT = 120;
const PAINT_INTERVAL_MS = 250;
const SAVE_INTERVAL_MS = 3000;

function patch(id: string, next: Partial<ProjectUploadJob>): void {
  useProjectUploads.setState((state) => ({
    jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...next } : job)),
  }));
}

function jobById(id: string): ProjectUploadJob | undefined {
  return useProjectUploads.getState().jobs.find((job) => job.id === id);
}

export function hasActiveProjectUpload(): boolean {
  return useProjectUploads.getState().jobs.some((job) => job.status === "uploading");
}

export interface StartProjectUploadInput {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly sourceName: string;
  readonly target: string;
  readonly targetLabel: string;
  readonly projectRef: ScopedProjectRef;
  /** Already planned (zips unpacked, top folder taken off). */
  readonly files: ReadonlyArray<ProjectUploadFile>;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly skipFolders: ReadonlyMap<string, string>;
  readonly leftOut: JobRuntime["leftOut"];
  readonly handle: FileSystemDirectoryHandleLike | null;
  readonly onFinished: (() => Promise<void>) | null;
}

export function startProjectUpload(input: StartProjectUploadInput): string {
  const id = `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  runtimes.set(id, {
    files: input.files,
    skipFolders: input.skipFolders,
    completed: new Set(),
    controller: null,
    onFinished: input.onFinished,
    leftOut: input.leftOut,
    handle: input.handle,
  });
  const job: ProjectUploadJob = {
    id,
    environmentId: input.environmentId,
    name: input.name,
    sourceName: input.sourceName,
    target: input.target,
    targetLabel: input.targetLabel,
    projectRef: input.projectRef,
    status: "uploading",
    totalFiles: input.totalFiles,
    totalBytes: input.totalBytes,
    completedFiles: 0,
    sentBytes: 0,
    samples: [],
    error: null,
    attached: true,
    hasHandle: input.handle !== null,
  };
  useProjectUploads.setState((state) => ({
    jobs: [...state.jobs.filter((entry) => entry.status !== "done"), job],
  }));
  void run(id);
  return id;
}

async function run(id: string, attempt = 0): Promise<void> {
  const runtime = runtimes.get(id);
  const job = jobById(id);
  if (!runtime || !job || !runtime.files) return;
  const controller = new AbortController();
  runtime.controller = controller;
  patch(
    id,
    attempt === 0 ? { status: "uploading", error: null, samples: [] } : { status: "uploading" },
  );
  void saveJob(id);
  let lastPaint = 0;
  let lastSave = Date.now();
  try {
    const api = ensureEnvironmentApi(job.environmentId);
    await uploadFilesIntoDirectory(computerUploadDeps(api), {
      targetDir: job.target,
      files: runtime.files,
      filterIgnored: true,
      skipFolders: runtime.skipFolders,
      concurrency: PROJECT_UPLOAD_PARALLEL_FILES,
      alreadyUploaded: runtime.completed,
      signal: controller.signal,
      onFileUploaded: (relativePath) => {
        runtime.completed.add(relativePath);
        if (Date.now() - lastSave > SAVE_INTERVAL_MS) {
          lastSave = Date.now();
          void saveJob(id);
        }
      },
      onProgress: (progress) => {
        const now = Date.now();
        const final = progress.completedFiles === progress.totalFiles;
        if (now - lastPaint < PAINT_INTERVAL_MS && !final) return;
        lastPaint = now;
        const current = jobById(id);
        const samples = [
          ...(current?.samples ?? []),
          { at: now, sentBytes: progress.sentBytes, completedFiles: progress.completedFiles },
        ].slice(-SAMPLE_LIMIT);
        patch(id, {
          error: null,
          completedFiles: progress.completedFiles,
          sentBytes: progress.sentBytes,
          totalFiles: progress.totalFiles,
          totalBytes: progress.totalBytes,
          samples,
        });
      },
    });
    if (runtime.leftOut) {
      const blob = new Blob([runtime.leftOut.text], { type: "text/plain" });
      await uploadFilesIntoDirectory(
        { writeFile: (write) => api.projects.writeFile(write) },
        {
          targetDir: job.target,
          files: [{ relativePath: runtime.leftOut.fileName, size: blob.size, blob }],
          filterIgnored: false,
        },
      );
    }
    runtime.controller = null;
    runtime.files = null;
    runtime.handle = null;
    patch(id, { status: "done", completedFiles: jobById(id)?.totalFiles ?? 0 });
    void forgetJob(id);
    if (jobById(id)?.attached) await openUploadedProject(id);
  } catch (error) {
    runtime.controller = null;
    const stopped = controller.signal.aborted;
    void saveJob(id);
    // A dropped connection is usually back in seconds: try again on our own
    // a few times before asking the person. A full disk isn't back in seconds.
    if (!stopped && !isNotEnoughSpaceError(error) && attempt < AUTO_RETRY_DELAYS_MS.length) {
      patch(id, { error: "Connection dropped — trying again…" });
      await new Promise((resolve) => setTimeout(resolve, AUTO_RETRY_DELAYS_MS[attempt]));
      // Stopped or dismissed while waiting: leave it as the person left it.
      if (jobById(id)?.status !== "uploading" || !runtimes.has(id)) return;
      await run(id, attempt + 1);
      return;
    }
    patch(id, {
      status: stopped ? "stopped" : "failed",
      error: stopped ? null : uploadErrorText(error),
    });
    void saveJob(id);
  }
}

/** Waits before the automatic tries after a failure; then the person decides. */
const AUTO_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/** The person's words for a failure: the computer went away, or what it said. */
export function uploadErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isNotEnoughSpaceError(error)) return `${message} Then Resume.`;
  if (/socket|websocket|closed|disconnect|network|timed? ?out|not connected/i.test(message)) {
    return "Lost the connection to the computer. What's already there stays — Resume sends the rest.";
  }
  if (/no space|ENOSPC|disk/i.test(message)) {
    return "The computer is out of disk space. Free some up, then Resume.";
  }
  return `The upload stopped: ${message}. What's already there stays — Resume sends the rest.`;
}

export function stopProjectUpload(id: string): void {
  const runtime = runtimes.get(id);
  if (runtime?.controller) {
    runtime.controller.abort();
  } else if (jobById(id)?.status === "uploading") {
    // Between automatic tries: nothing in flight to abort.
    patch(id, { status: "stopped", error: null });
    void saveJob(id);
  }
}

/** The dialog shows this job (or stopped showing it: the panel takes over). */
export function attachProjectUpload(id: string, attached: boolean): void {
  if (jobById(id)) patch(id, { attached });
}

export function dismissProjectUpload(id: string): void {
  runtimes.get(id)?.controller?.abort();
  runtimes.delete(id);
  void forgetJob(id);
  useProjectUploads.setState((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) }));
}

/** Fallback ending when the dialog's own one is gone (e.g. after a reload). */
let openProjectFallback: ((projectRef: ScopedProjectRef) => Promise<void>) | null = null;

export function setOpenUploadedProjectFallback(
  open: ((projectRef: ScopedProjectRef) => Promise<void>) | null,
): void {
  openProjectFallback = open;
}

/** "Open": the dialog's ending if it is still around, else a new chat in the project. */
export async function openUploadedProject(id: string): Promise<void> {
  const job = jobById(id);
  if (!job) return;
  const runtime = runtimes.get(id);
  const finished = runtime?.onFinished ?? null;
  useProjectUploads.setState((state) => ({ jobs: state.jobs.filter((entry) => entry.id !== id) }));
  runtimes.delete(id);
  if (finished) {
    await finished();
    return;
  }
  await openProjectFallback?.(job.projectRef);
}

/**
 * Resume: in this tab — straight on with the files it has. After a reload —
 * the browser asks to see the folder again (or the person picks it), then only
 * what is not on the computer yet goes. Call from a click.
 */
export async function resumeProjectUpload(id: string): Promise<void> {
  const job = jobById(id);
  const runtime = runtimes.get(id);
  if (!job || !runtime) return;
  if (runtime.files) {
    void run(id);
    return;
  }
  let read: ReadFolder | null = null;
  try {
    if (runtime.handle?.requestPermission) {
      const permission = await runtime.handle.requestPermission({ mode: "read" });
      if (permission === "granted") {
        patch(id, { error: null });
        read = await readDirectoryHandle(runtime.handle);
      }
    }
    if (!read) {
      read = await chooseFolderForProjectUpload();
      if (!read) return;
    }
  } catch (error) {
    patch(id, { error: uploadErrorText(error) });
    return;
  }
  const top = read.files[0]?.relativePath.split("/")[0] ?? "";
  if (top !== job.sourceName) {
    patch(id, {
      error: `That's another folder. Pick “${job.sourceName}” to continue this upload.`,
    });
    return;
  }
  runtime.files = stripSharedTopFolder(read.files, (file, relativePath) => ({
    ...file,
    relativePath,
  }));
  if (read.handle) runtime.handle = read.handle;
  void run(id);
}

// ── Saved jobs (IndexedDB): resume after the tab or the app was closed ──

const DB_NAME = "uno-work-project-uploads";
const STORE = "jobs";

interface SavedJob {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly sourceName: string;
  readonly target: string;
  readonly targetLabel: string;
  readonly projectRef: ScopedProjectRef;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly sentBytes: number;
  readonly completed: ReadonlyArray<string>;
  readonly skipFolders: ReadonlyArray<readonly [string, string]>;
  readonly leftOut: JobRuntime["leftOut"];
  readonly handle: FileSystemDirectoryHandleLike | null;
  readonly savedAt: string;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.addEventListener("upgradeneeded", () =>
      request.result.createObjectStore(STORE, { keyPath: "id" }),
    );
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => resolve(null));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => resolve(null));
    } catch {
      resolve(null);
    }
  }).finally(() => db.close()) as Promise<T | null>;
}

async function saveJob(id: string): Promise<void> {
  const job = jobById(id);
  const runtime = runtimes.get(id);
  if (!job || !runtime) return;
  const saved: SavedJob = {
    id,
    environmentId: job.environmentId,
    name: job.name,
    sourceName: job.sourceName,
    target: job.target,
    targetLabel: job.targetLabel,
    projectRef: job.projectRef,
    totalFiles: job.totalFiles,
    totalBytes: job.totalBytes,
    sentBytes: job.sentBytes,
    completed: [...runtime.completed],
    skipFolders: [...runtime.skipFolders.entries()],
    leftOut: runtime.leftOut,
    handle: runtime.handle,
    savedAt: new Date().toISOString(),
  };
  const stored = await withStore("readwrite", (store) => store.put(saved));
  // Some browsers can't keep a folder handle: keep the rest (Resume asks to pick it again).
  if (stored === null && saved.handle) {
    await withStore("readwrite", (store) => store.put({ ...saved, handle: null }));
  }
}

async function forgetJob(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

let restored = false;

/** Once per tab: uploads a closed tab or app left unfinished come back as Resume. */
export async function restoreInterruptedUploads(): Promise<void> {
  if (restored) return;
  restored = true;
  const saved = (await withStore("readonly", (store) => store.getAll())) as SavedJob[] | null;
  if (!saved || saved.length === 0) return;
  const known = new Set(useProjectUploads.getState().jobs.map((job) => job.id));
  const jobs: ProjectUploadJob[] = [];
  for (const entry of saved) {
    if (known.has(entry.id)) continue;
    runtimes.set(entry.id, {
      files: null,
      skipFolders: new Map(entry.skipFolders),
      completed: new Set(entry.completed),
      controller: null,
      onFinished: null,
      leftOut: entry.leftOut,
      handle: entry.handle,
    });
    jobs.push({
      id: entry.id,
      environmentId: entry.environmentId,
      name: entry.name,
      sourceName: entry.sourceName,
      target: entry.target,
      targetLabel: entry.targetLabel,
      projectRef: entry.projectRef,
      status: "interrupted",
      totalFiles: entry.totalFiles,
      totalBytes: entry.totalBytes,
      completedFiles: entry.completed.length,
      sentBytes: entry.sentBytes,
      samples: [],
      error: null,
      attached: false,
      hasHandle: entry.handle !== null,
    });
  }
  if (jobs.length > 0) {
    useProjectUploads.setState((state) => ({ jobs: [...state.jobs, ...jobs] }));
  }
}
