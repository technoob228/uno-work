/**
 * The capture engine of Loom Work: screen (+ camera circle) + voice →
 * two MediaRecorders.
 *
 * - The **video** (what goes to Uno Drive and the share link): the screen as
 *   is, or — with the camera on — composited on a canvas with the camera in a
 *   circle bottom-left. One file anyone can play; no second track to sync.
 * - The **agent copy**: the same screen, small and slow (≤1280 px, ≤5 fps,
 *   ~0.35 Mbit/s) with the voice, cut into self-contained 5-minute parts
 *   (~14 MB each): one part is watched in one gateway call, a longer
 *   recording (up to 60 minutes) part by part from Uno Drive.
 *
 * The compositing loop is driven by a Worker timer, not requestAnimationFrame:
 * the person switches to the tab/app they are showing, Work's tab goes to the
 * background, and rAF (and page timers) would stall or drop to 1 Hz there.
 *
 * Everything the browser gives is injected (`RecorderEnv`) so the state
 * machine is tested without a browser.
 */
import {
  type CaptureProblem,
  type RecordingOptions,
  baseMimeType,
  cameraBubbleRect,
  compositeSize,
  describeCaptureError,
  displayMediaOptions,
  pickRecorderMimeType,
} from "./recordingLogic";

export interface Ticker {
  stop(): void;
}

export interface RecorderEnv {
  readonly mediaDevices: Pick<MediaDevices, "getDisplayMedia" | "getUserMedia">;
  readonly MediaRecorder: {
    new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
    isTypeSupported(type: string): boolean;
  };
  readonly now: () => number;
  /** A canvas for compositing; null where there is none (then the camera is left out). */
  readonly createCanvas: () => HTMLCanvasElement | null;
  /** A playing, muted <video> for a stream (a frame source for the canvas). */
  readonly createVideo: (stream: MediaStream) => Promise<HTMLVideoElement>;
  /** Calls `onTick` ~`fps` times a second, also in a background tab. */
  readonly createTicker: (fps: number, onTick: () => void) => Ticker;
  /** Mixes several audio tracks into one; null when only one or none. */
  readonly mixAudio: (
    tracks: MediaStreamTrack[],
  ) => { track: MediaStreamTrack; close(): void } | null;
  readonly platform?: { readonly mac: boolean; readonly desktopApp: boolean };
}

export class CaptureError extends Error {
  readonly problem: CaptureProblem;
  constructor(problem: CaptureProblem) {
    super(problem.message ?? "Recording cancelled.");
    this.name = "CaptureError";
    this.problem = problem;
  }
}

export interface RecordingResult {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly durationMs: number;
  /** The agent copy in self-contained parts of ≤ AGENT_PART_MS (each its own file). */
  readonly agentParts: ReadonlyArray<AgentPart>;
  readonly agentCopyMimeType: string | null;
  readonly width: number;
  readonly height: number;
  readonly hasVoice: boolean;
  readonly hasCamera: boolean;
}

export type RecorderState = "recording" | "paused" | "stopped";

/** One self-contained piece of the agent copy. */
export interface AgentPart {
  readonly blob: Blob;
  readonly durationMs: number;
}

/**
 * The agent copy is cut into parts of 5 minutes while recording: each part is
 * a whole file (a new MediaRecorder on the same stream), so long recordings
 * are watched part by part (≤ 25 MB, ≤ 10 min each) with no re-encoding.
 */
export const AGENT_PART_MS = 5 * 60 * 1000;

export interface RecorderEvents {
  /** The screen share ended from outside (the browser's "Stop sharing", window closed). */
  readonly onSourceEnded?: () => void;
  /** Camera or microphone could not be used; recording goes on without it. */
  readonly onWarning?: (message: string) => void;
  /** The browser's encoder failed mid-way: what was recorded so far is kept. */
  readonly onRecorderError?: (message: string) => void;
}

const MAIN_VIDEO_BPS = 2_500_000;
const MAIN_AUDIO_BPS = 96_000;
const AGENT_VIDEO_BPS = 350_000;
const AGENT_AUDIO_BPS = 32_000;
const COMPOSITE_FPS = 30;

function stopAll(stream: MediaStream | null | undefined) {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // already stopped
    }
  }
}

interface Capture {
  readonly blobs: Blob[];
  readonly recorder: MediaRecorder;
  readonly stopped: Promise<void>;
}

function startCapture(
  env: RecorderEnv,
  stream: MediaStream,
  mimeType: string | null,
  bits: { video: number; audio: number },
  onError?: (message: string) => void,
): Capture {
  const recorder = new env.MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: bits.video,
    audioBitsPerSecond: bits.audio,
  });
  const blobs: Blob[] = [];
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) blobs.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (event: Event) => {
      const error = (event as Event & { error?: { message?: string } }).error;
      onError?.(error?.message || "the browser's video encoder stopped");
      resolve();
    };
  });
  // Chunks every second: a crash late in a long recording loses one second.
  recorder.start(1000);
  return { blobs, recorder, stopped };
}

export class ScreenRecorder {
  private stateValue: RecorderState = "recording";
  private startedAt: number;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private finished: Promise<RecordingResult> | null = null;
  private cancelled = false;

  private constructor(
    private readonly env: RecorderEnv,
    private readonly parts: {
      readonly display: MediaStream;
      readonly camera: MediaStream | null;
      readonly microphone: MediaStream | null;
      readonly main: Capture;
      /** Starts a new part of the agent copy; null when the clone failed. */
      readonly startAgentPart: (() => Capture) | null;
      readonly mainMime: string;
      readonly agentMime: string | null;
      readonly ticker: Ticker | null;
      readonly mixer: { close(): void } | null;
      readonly extra: MediaStream[];
      readonly width: number;
      readonly height: number;
      readonly hasVoice: boolean;
    },
  ) {
    this.startedAt = env.now();
    if (parts.startAgentPart) {
      try {
        this.agentParts.push({ capture: parts.startAgentPart(), startMs: 0 });
      } catch {
        // No agent copy in this browser: the recording still goes to Drive.
      }
    }
  }

  private readonly agentParts: Array<{ capture: Capture; startMs: number; endMs?: number }> = [];

  private get agent(): Capture | null {
    return this.agentParts.at(-1)?.capture ?? null;
  }

  /**
   * Called about twice a second by the session: closes the agent copy's part
   * at AGENT_PART_MS of recording time and opens the next.
   */
  tick(): void {
    if (this.stateValue !== "recording" || !this.parts.startAgentPart) return;
    const current = this.agentParts.at(-1);
    if (!current) return;
    const now = this.elapsedMs();
    if (now - current.startMs < AGENT_PART_MS) return;
    current.endMs = now;
    try {
      current.capture.recorder.stop();
    } catch {
      // already stopped
    }
    try {
      this.agentParts.push({ capture: this.parts.startAgentPart(), startMs: now });
    } catch {
      // The rest of the recording has no agent copy; what was cut stays.
    }
  }

  /** The camera stream, for the preview circle in the control bar. */
  get cameraStream(): MediaStream | null {
    return this.parts.camera;
  }

  get state(): RecorderState {
    return this.stateValue;
  }

  get hasVoice(): boolean {
    return this.parts.hasVoice;
  }

  /** The person's microphone is in (not just the tab's sound). */
  get hasMicrophone(): boolean {
    return (this.parts.microphone?.getAudioTracks().length ?? 0) > 0;
  }

  elapsedMs(): number {
    const end = this.pausedAt ?? this.env.now();
    return Math.max(0, end - this.startedAt - this.pausedTotal);
  }

  pause(): void {
    if (this.stateValue !== "recording") return;
    for (const capture of [this.parts.main, this.agent]) {
      if (capture?.recorder.state === "recording") capture.recorder.pause();
    }
    this.pausedAt = this.env.now();
    this.stateValue = "paused";
  }

  resume(): void {
    if (this.stateValue !== "paused") return;
    for (const capture of [this.parts.main, this.agent]) {
      if (capture?.recorder.state === "paused") capture.recorder.resume();
    }
    if (this.pausedAt !== null) this.pausedTotal += this.env.now() - this.pausedAt;
    this.pausedAt = null;
    this.stateValue = "recording";
  }

  /** Finish and hand over the files. Safe to call twice (same result). */
  stop(): Promise<RecordingResult> {
    if (this.finished) return this.finished;
    const durationMs = this.elapsedMs();
    this.stateValue = "stopped";
    this.finished = (async () => {
      const { main } = this.parts;
      const last = this.agentParts.at(-1);
      if (last) last.endMs = durationMs;
      for (const capture of [main, last?.capture ?? null]) {
        if (capture && capture.recorder.state !== "inactive") {
          try {
            capture.recorder.stop();
          } catch {
            // already stopped by the source ending
          }
        }
      }
      await Promise.all([main.stopped, ...this.agentParts.map((part) => part.capture.stopped)]);
      this.release();
      const mainType = baseMimeType(main.recorder.mimeType || this.parts.mainMime);
      const blob = new Blob(main.blobs, { type: mainType });
      const agentType = last
        ? baseMimeType(last.capture.recorder.mimeType || this.parts.agentMime || mainType)
        : null;
      const agentParts = this.agentParts
        .map((part) => ({
          blob: new Blob(part.capture.blobs, { type: agentType ?? mainType }),
          durationMs: Math.max(0, (part.endMs ?? durationMs) - part.startMs),
        }))
        .filter((part) => part.blob.size > 0);
      return {
        blob,
        mimeType: mainType,
        durationMs,
        agentParts,
        agentCopyMimeType: agentParts.length > 0 ? agentType : null,
        width: this.parts.width,
        height: this.parts.height,
        hasVoice: this.parts.hasVoice,
        hasCamera: this.parts.camera !== null,
      };
    })();
    return this.finished;
  }

  /** Throw everything away. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stateValue = "stopped";
    for (const capture of [this.parts.main, this.agent]) {
      if (capture && capture.recorder.state !== "inactive") {
        try {
          capture.recorder.stop();
        } catch {
          // ignore
        }
      }
    }
    this.release();
  }

  private released = false;
  private release() {
    if (this.released) return;
    this.released = true;
    this.parts.ticker?.stop();
    this.parts.mixer?.close();
    stopAll(this.parts.display);
    stopAll(this.parts.camera);
    stopAll(this.parts.microphone);
    for (const stream of this.parts.extra) stopAll(stream);
  }

  /**
   * Asks for the screen (the browser's picker), then camera and microphone.
   * Throws `CaptureError` when there is no screen (closed picker = kind
   * "cancelled", no message). Camera/microphone problems are warnings.
   */
  static async start(
    options: RecordingOptions,
    env: RecorderEnv,
    events: RecorderEvents = {},
  ): Promise<ScreenRecorder> {
    const platform = env.platform ?? { mac: false, desktopApp: false };
    let display: MediaStream;
    try {
      display = await env.mediaDevices.getDisplayMedia(displayMediaOptions(options));
    } catch (error) {
      throw new CaptureError(describeCaptureError(error, "screen", platform));
    }
    const screenTrack = display.getVideoTracks()[0];
    if (!screenTrack) {
      stopAll(display);
      throw new CaptureError({ kind: "failed", message: "The screen share has no picture." });
    }

    let camera: MediaStream | null = null;
    let microphone: MediaStream | null = null;
    if (options.camera) {
      try {
        camera = await env.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: "user" },
          audio: false,
        });
      } catch (error) {
        const problem = describeCaptureError(error, "camera", platform);
        if (problem.message) events.onWarning?.(problem.message);
      }
    }
    if (options.microphone) {
      try {
        microphone = await env.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
      } catch (error) {
        const problem = describeCaptureError(error, "microphone", platform);
        if (problem.message) events.onWarning?.(problem.message);
      }
    }

    const extra: MediaStream[] = [];
    let ticker: Ticker | null = null;
    let mixer: { track: MediaStreamTrack; close(): void } | null = null;
    try {
      const settings = screenTrack.getSettings?.() ?? {};
      const size = compositeSize(settings.width ?? 0, settings.height ?? 0);

      // Video: the screen as is, or screen + camera circle on a canvas.
      let videoTrack: MediaStreamTrack = screenTrack;
      const canvas = camera ? env.createCanvas() : null;
      if (camera && !canvas) {
        events.onWarning?.("The camera circle isn't available here — recording the screen only.");
        stopAll(camera);
        camera = null;
      }
      if (camera && canvas) {
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        const [screenVideo, cameraVideo] = await Promise.all([
          env.createVideo(new MediaStream([screenTrack])),
          env.createVideo(camera),
        ]);
        const bubble = cameraBubbleRect(size.width, size.height);
        const draw = () => {
          if (!context) return;
          context.drawImage(screenVideo, 0, 0, size.width, size.height);
          const vw = cameraVideo.videoWidth || 1;
          const vh = cameraVideo.videoHeight || 1;
          const side = Math.min(vw, vh);
          context.save();
          context.beginPath();
          context.arc(
            bubble.x + bubble.size / 2,
            bubble.y + bubble.size / 2,
            bubble.size / 2,
            0,
            Math.PI * 2,
          );
          context.closePath();
          context.clip();
          // Mirror like a selfie: people expect to see themselves that way.
          context.translate(bubble.x + bubble.size, bubble.y);
          context.scale(-1, 1);
          context.drawImage(
            cameraVideo,
            (vw - side) / 2,
            (vh - side) / 2,
            side,
            side,
            0,
            0,
            bubble.size,
            bubble.size,
          );
          context.restore();
          context.beginPath();
          context.arc(
            bubble.x + bubble.size / 2,
            bubble.y + bubble.size / 2,
            bubble.size / 2 - 1.5,
            0,
            Math.PI * 2,
          );
          context.lineWidth = 3;
          context.strokeStyle = "rgba(255,255,255,0.9)";
          context.stroke();
        };
        draw();
        ticker = env.createTicker(COMPOSITE_FPS, draw);
        const canvasStream = canvas.captureStream(COMPOSITE_FPS);
        extra.push(canvasStream);
        const canvasTrack = canvasStream.getVideoTracks()[0];
        if (canvasTrack) videoTrack = canvasTrack;
      }

      // Voice: microphone and the tab's/system sound, mixed when both.
      const audioTracks = [...(microphone?.getAudioTracks() ?? []), ...display.getAudioTracks()];
      let audioTrack: MediaStreamTrack | null = audioTracks[0] ?? null;
      if (audioTracks.length > 1) {
        mixer = env.mixAudio(audioTracks);
        if (mixer) audioTrack = mixer.track;
      }

      const mainMime = pickRecorderMimeType((type) => env.MediaRecorder.isTypeSupported(type));
      const mainStream = new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack]);
      const main = startCapture(
        env,
        mainStream,
        mainMime,
        { video: MAIN_VIDEO_BPS, audio: MAIN_AUDIO_BPS },
        events.onRecorderError,
      );

      // The agent copy: a clone of the screen, small and slow, in parts.
      let startAgentPart: (() => Capture) | null = null;
      try {
        const small = screenTrack.clone();
        await small
          .applyConstraints({ width: { max: 1280 }, frameRate: { max: 5 } })
          .catch(() => undefined);
        const agentStream = new MediaStream(audioTrack ? [small, audioTrack.clone()] : [small]);
        extra.push(agentStream);
        startAgentPart = () =>
          startCapture(env, agentStream, mainMime, {
            video: AGENT_VIDEO_BPS,
            audio: AGENT_AUDIO_BPS,
          });
      } catch {
        startAgentPart = null;
      }

      const recorder = new ScreenRecorder(env, {
        display,
        camera,
        microphone,
        main,
        startAgentPart,
        mainMime: mainMime ?? "video/webm",
        agentMime: mainMime,
        ticker,
        mixer,
        extra,
        width: size.width,
        height: size.height,
        hasVoice: audioTrack !== null,
      });
      screenTrack.addEventListener("ended", () => {
        if (recorder.state !== "stopped") events.onSourceEnded?.();
      });
      return recorder;
    } catch (error) {
      ticker?.stop();
      mixer?.close();
      stopAll(display);
      stopAll(camera);
      stopAll(microphone);
      for (const stream of extra) stopAll(stream);
      throw new CaptureError({
        kind: "failed",
        message: `Couldn't start recording: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

// ── The real browser ─────────────────────────────────────────────────────

const TICKER_WORKER_SOURCE = `let id=null;onmessage=(e)=>{if(id!==null)clearInterval(id);id=null;if(e.data>0)id=setInterval(()=>postMessage(0),e.data);};`;

/** setInterval in a Worker: not throttled when Work's tab is in the background. */
function workerTicker(fps: number, onTick: () => void): Ticker {
  const interval = Math.max(10, Math.round(1000 / fps));
  try {
    const url = URL.createObjectURL(new Blob([TICKER_WORKER_SOURCE], { type: "text/javascript" }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = () => onTick();
    worker.postMessage(interval);
    return {
      stop: () => {
        worker.postMessage(0);
        worker.terminate();
      },
    };
  } catch {
    const id = setInterval(onTick, interval);
    return { stop: () => clearInterval(id) };
  }
}

async function playingVideo(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  if (video.readyState < 2) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener("loadeddata", done, { once: true });
      setTimeout(done, 1500);
    });
  }
  return video;
}

function webAudioMix(tracks: MediaStreamTrack[]) {
  const AudioCtor =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) return null;
  const context = new AudioCtor();
  const destination = context.createMediaStreamDestination();
  for (const track of tracks) {
    context.createMediaStreamSource(new MediaStream([track])).connect(destination);
  }
  const track = destination.stream.getAudioTracks()[0];
  if (!track) {
    void context.close();
    return null;
  }
  return { track, close: () => void context.close().catch(() => undefined) };
}

export function browserRecorderEnv(platform: { mac: boolean; desktopApp: boolean }): RecorderEnv {
  return {
    mediaDevices: navigator.mediaDevices,
    MediaRecorder,
    now: () => performance.now(),
    createCanvas: () => {
      const canvas = document.createElement("canvas");
      return typeof canvas.captureStream === "function" ? canvas : null;
    },
    createVideo: playingVideo,
    createTicker: workerTicker,
    mixAudio: webAudioMix,
    platform,
  };
}
