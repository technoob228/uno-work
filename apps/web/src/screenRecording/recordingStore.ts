/**
 * Loom Work state: one recording session at a time (the control bar is
 * global — the person leaves Work to show things), and one finished recording
 * card per chat. The pipeline runs here, not in a component, so switching
 * chats while it saves/watches loses nothing.
 */
import { create } from "zustand";

import {
  INITIAL_SAVE,
  INITIAL_WATCH,
  type PipelineDeps,
  type RecordingItem,
  type SaveStep,
  type WatchStep,
  cleanupStaging,
  recordingReadiness,
  runPipeline,
  runSave,
  runWatch,
} from "./pipeline";
import { CaptureError, type RecorderEnv, ScreenRecorder } from "./recorder";
import {
  DEFAULT_RECORDING_OPTIONS,
  RECORDING_MAX_MS,
  type RecordingForAgent,
  type RecordingOptions,
  recordingFileName,
} from "./recordingLogic";

export type SessionPhase = "idle" | "starting" | "recording" | "paused" | "finishing";

export interface RecordingSession {
  readonly phase: SessionPhase;
  readonly threadKey: string | null;
  readonly environmentId: string | null;
  readonly cameraStream: MediaStream | null;
  readonly hasVoice: boolean;
  /** The person's microphone is in. */
  readonly hasMicrophone: boolean;
  /** Why the recording stopped by itself ("limit", "source-ended"), for the card. */
  readonly stoppedBy: "person" | "limit" | "source-ended" | null;
}

export interface Notice {
  readonly kind: "error" | "warning" | "info";
  readonly title: string;
  readonly description?: string;
}

export interface RecordingRuntime {
  readonly env: () => RecorderEnv;
  readonly deps: (environmentId: string) => PipelineDeps;
  readonly notify: (notice: Notice) => void;
  readonly createObjectUrl: (blob: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
  readonly newId: () => string;
  readonly now: () => Date;
}

interface StoreState {
  readonly options: RecordingOptions;
  readonly session: RecordingSession;
  readonly items: Readonly<Record<string, RecordingItem>>;
  setOptions: (options: Partial<RecordingOptions>) => void;
  start: (input: { threadKey: string; environmentId: string }) => Promise<boolean>;
  pause: () => void;
  resume: () => void;
  stop: (by?: "person" | "limit" | "source-ended") => Promise<void>;
  cancel: () => void;
  elapsedMs: () => number;
  retrySave: (threadKey: string) => void;
  retryWatch: (threadKey: string) => void;
  remove: (threadKey: string) => void;
  markPrefilled: (threadKey: string) => void;
  /** For the message: the agent's block; removes the card (the file stays in Drive). */
  take: (threadKey: string) => { forAgent: RecordingForAgent; item: RecordingItem } | null;
  /** The send failed: the card comes back. */
  restore: (item: RecordingItem) => void;
  /**
   * The card goes to another chat (Home's recording → the new chat it starts).
   * Only a card that isn't saving or watching moves; a card already there is
   * replaced. True when it moved.
   */
  moveTo: (fromKey: string, toKey: string) => boolean;
}

const IDLE: RecordingSession = {
  phase: "idle",
  threadKey: null,
  environmentId: null,
  cameraStream: null,
  hasVoice: false,
  hasMicrophone: false,
  stoppedBy: null,
};

const OPTIONS_KEY = "uno:recording-options";

function readOptions(): RecordingOptions {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_RECORDING_OPTIONS;
    const stored = JSON.parse(
      localStorage.getItem(OPTIONS_KEY) ?? "{}",
    ) as Partial<RecordingOptions>;
    return { ...DEFAULT_RECORDING_OPTIONS, ...stored };
  } catch {
    return DEFAULT_RECORDING_OPTIONS;
  }
}

let runtime: RecordingRuntime | null = null;
let recorder: ScreenRecorder | null = null;
let limitTimer: ReturnType<typeof setInterval> | null = null;
const controllers = new Map<string, AbortController>();
/** Recordings sent in this session: name → blob URL, so the message plays at once. */
const sentRecordingUrls = new Map<string, string>();

export function localRecordingUrl(name: string): string | null {
  return sentRecordingUrls.get(name) ?? null;
}

/** The app (or a test) says how to reach the browser and the computer. */
export function configureRecordingRuntime(next: RecordingRuntime) {
  runtime = next;
}

function rt(): RecordingRuntime {
  if (!runtime) throw new Error("Screen recording isn't set up.");
  return runtime;
}

export const useScreenRecordingStore = create<StoreState>((set, get) => {
  const patchItem = (
    threadKey: string,
    id: string,
    update: { save?: Partial<SaveStep>; watch?: Partial<WatchStep> },
  ) => {
    set((state) => {
      const item = state.items[threadKey];
      if (!item || item.id !== id) return state;
      return {
        items: {
          ...state.items,
          [threadKey]: {
            ...item,
            save: update.save ? { ...item.save, ...update.save } : item.save,
            watch: update.watch ? { ...item.watch, ...update.watch } : item.watch,
          },
        },
      };
    });
  };

  const controllerFor = (id: string) => {
    controllers.get(id)?.abort();
    const controller = new AbortController();
    controllers.set(id, controller);
    return controller;
  };

  const clearLimitTimer = () => {
    if (limitTimer) clearInterval(limitTimer);
    limitTimer = null;
  };

  return {
    options: readOptions(),
    session: IDLE,
    items: {},

    setOptions: (partial) => {
      const options = { ...get().options, ...partial };
      try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
      } catch {
        // private mode
      }
      set({ options });
    },

    start: async ({ threadKey, environmentId }) => {
      if (get().session.phase !== "idle") return false;
      const { env, notify } = rt();
      set({ session: { ...IDLE, phase: "starting", threadKey, environmentId } });
      try {
        recorder = await ScreenRecorder.start(get().options, env(), {
          onSourceEnded: () => void get().stop("source-ended"),
          onWarning: (message) => notify({ kind: "warning", title: message }),
          onRecorderError: (message) => {
            notify({
              kind: "error",
              title: "The recording stopped",
              description: `${message}. What was recorded so far is kept.`,
            });
            void get().stop("source-ended");
          },
        });
      } catch (error) {
        recorder = null;
        set({ session: IDLE });
        if (error instanceof CaptureError) {
          if (error.problem.message) {
            notify({
              kind: "error",
              title: "Couldn't start recording",
              description: error.problem.message,
            });
          }
        } else {
          notify({
            kind: "error",
            title: "Couldn't start recording",
            description: error instanceof Error ? error.message : String(error),
          });
        }
        return false;
      }
      set({
        session: {
          phase: "recording",
          threadKey,
          environmentId,
          cameraStream: recorder.cameraStream,
          hasVoice: recorder.hasVoice,
          hasMicrophone: recorder.hasMicrophone,
          stoppedBy: null,
        },
      });
      clearLimitTimer();
      limitTimer = setInterval(() => {
        if (!recorder) return;
        recorder.tick();
        if (recorder.elapsedMs() >= RECORDING_MAX_MS) void get().stop("limit");
      }, 500);
      return true;
    },

    pause: () => {
      if (!recorder || get().session.phase !== "recording") return;
      recorder.pause();
      set((state) => ({ session: { ...state.session, phase: "paused" } }));
    },

    resume: () => {
      if (!recorder || get().session.phase !== "paused") return;
      recorder.resume();
      set((state) => ({ session: { ...state.session, phase: "recording" } }));
    },

    stop: async (by = "person") => {
      const session = get().session;
      const current = recorder;
      if (!current || (session.phase !== "recording" && session.phase !== "paused")) return;
      clearLimitTimer();
      set({ session: { ...session, phase: "finishing", stoppedBy: by } });
      const { notify, createObjectUrl, newId, now, deps, revokeObjectUrl } = rt();
      let result;
      try {
        result = await current.stop();
      } finally {
        recorder = null;
      }
      set({ session: IDLE });
      if (by === "limit") {
        notify({
          kind: "info",
          title: "Stopped at 60 minutes",
          description: "That's the longest recording for now.",
        });
      }
      if (result.blob.size === 0) {
        notify({
          kind: "error",
          title: "Nothing was recorded",
          description: "Try again — the screen share ended right away.",
        });
        return;
      }
      const threadKey = session.threadKey!;
      const environmentId = session.environmentId!;
      const previous = get().items[threadKey];
      if (previous) {
        controllers.get(previous.id)?.abort();
        revokeObjectUrl(previous.previewUrl);
      }
      const item: RecordingItem = {
        id: newId(),
        threadKey,
        environmentId,
        name: recordingFileName(now(), result.mimeType),
        mimeType: result.mimeType,
        sizeBytes: result.blob.size,
        durationMs: result.durationMs,
        blob: result.blob,
        previewUrl: createObjectUrl(result.blob),
        agentParts: result.agentParts,
        agentCopyMimeType: result.agentCopyMimeType,
        hasVoice: result.hasVoice,
        createdAt: now().toISOString(),
        save: { ...INITIAL_SAVE },
        watch: { ...INITIAL_WATCH },
        prefilled: false,
      };
      set((state) => ({ items: { ...state.items, [threadKey]: item } }));
      const controller = controllerFor(item.id);
      void runPipeline(
        item,
        deps(environmentId),
        (update) => patchItem(threadKey, item.id, update),
        controller.signal,
      );
    },

    cancel: () => {
      clearLimitTimer();
      recorder?.cancel();
      recorder = null;
      set({ session: IDLE });
    },

    elapsedMs: () => recorder?.elapsedMs() ?? 0,

    retrySave: (threadKey) => {
      const item = get().items[threadKey];
      if (!item || item.save.status === "running") return;
      const controller = controllerFor(`${item.id}:save`);
      void runSave(
        item,
        rt().deps(item.environmentId),
        (save) => patchItem(threadKey, item.id, { save }),
        controller.signal,
      );
    },

    retryWatch: (threadKey) => {
      const item = get().items[threadKey];
      if (!item || item.watch.status === "running") return;
      const controller = controllerFor(`${item.id}:watch`);
      void runWatch(
        item,
        rt().deps(item.environmentId),
        (watch) => patchItem(threadKey, item.id, { watch }),
        controller.signal,
      );
    },

    remove: (threadKey) => {
      const item = get().items[threadKey];
      if (!item) return;
      for (const key of [item.id, `${item.id}:save`, `${item.id}:watch`]) {
        controllers.get(key)?.abort();
        controllers.delete(key);
      }
      rt().revokeObjectUrl(item.previewUrl);
      void cleanupStaging(item, rt().deps(item.environmentId));
      set((state) => {
        const items = { ...state.items };
        delete items[threadKey];
        return { items };
      });
    },

    markPrefilled: (threadKey) => {
      set((state) => {
        const item = state.items[threadKey];
        if (!item || item.prefilled) return state;
        return { items: { ...state.items, [threadKey]: { ...item, prefilled: true } } };
      });
    },

    take: (threadKey) => {
      const item = get().items[threadKey];
      if (!item || !recordingReadiness(item).ready) return null;
      const recording: RecordingForAgent = {
        name: item.name,
        durationMs: item.durationMs,
        driveKey: item.save.status === "done" ? item.save.driveKey : null,
        shareUrl: item.save.status === "done" ? item.save.shareUrl : null,
        speech: item.watch.speech,
        visual: item.watch.visual,
      };
      for (const key of [item.id, `${item.id}:save`, `${item.id}:watch`]) controllers.delete(key);
      set((state) => {
        const items = { ...state.items };
        delete items[threadKey];
        return { items };
      });
      // The preview stays playable in this session's message (blob URL kept).
      sentRecordingUrls.set(item.name, item.previewUrl);
      return { forAgent: recording, item };
    },

    restore: (item) => {
      sentRecordingUrls.delete(item.name);
      set((state) => ({ items: { ...state.items, [item.threadKey]: item } }));
    },

    moveTo: (fromKey, toKey) => {
      const item = get().items[fromKey];
      if (!item || fromKey === toKey || recordingReadiness(item).busy) return false;
      const replaced = get().items[toKey];
      if (replaced) get().remove(toKey);
      set((state) => {
        const items = { ...state.items };
        delete items[fromKey];
        // The person already had the words put in the box where they recorded.
        items[toKey] = { ...item, threadKey: toKey, prefilled: true };
        return { items };
      });
      return true;
    },
  };
});

/** Test helper: back to a clean store. */
export function resetScreenRecordingStoreForTests() {
  recorder = null;
  if (limitTimer) clearInterval(limitTimer);
  limitTimer = null;
  controllers.clear();
  useScreenRecordingStore.setState({
    session: IDLE,
    items: {},
    options: DEFAULT_RECORDING_OPTIONS,
  });
}
