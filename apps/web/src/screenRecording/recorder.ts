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
  type DisplaySurface,
  type KeyFrameCandidate,
  type KeyFrameReason,
  MOVE_SAMPLE_MS,
  type PointerSample,
  RECORDING_EVENTS_MAX,
  type RecordingEvent,
  type ViewportInfo,
  mapPointerToFrame,
} from "./agentView";
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
  /**
   * Clicks and moves of the pointer inside Work (its tab or window); returns
   * the unsubscribe. Absent: no event track, no click rings, no key frames.
   */
  readonly subscribePointer?: (onSample: (sample: PointerSample) => void) => () => void;
  /** Work's window and screen, to place a pointer event on the video. */
  readonly viewport?: () => ViewportInfo;
  /** A canvas → JPEG (key frames); null when the engine can't. */
  readonly encodeJpeg?: (canvas: HTMLCanvasElement) => Promise<Blob | null>;
}

/** A key frame grabbed while recording (the screen only, ≤ 1280 px wide). */
export interface LiveKeyFrame extends KeyFrameCandidate {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

/** Key frames held in memory while recording (~100–200 KB each). */
export const LIVE_KEY_FRAMES_MAX = 60;
/** The screen counts as changed when a 32×18 thumbnail moves this much (0..255 mean). */
export const SCENE_CHANGE_THRESHOLD = 12;
const SCENE_MIN_GAP_MS = 2000;
const SCENE_SETTLE_MS = 500;
const CLICK_FRAME_DELAY_MS = 250;
const RIPPLE_MS = 700;
const KEY_FRAME_MAX_WIDTH = 1280;

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
  /** Clicks, cursor moves and screen changes Work saw (times in ms of recording). */
  readonly events: ReadonlyArray<RecordingEvent>;
  /** Pictures grabbed at clicks, screen changes and the start. */
  readonly keyFrames: ReadonlyArray<LiveKeyFrame>;
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

/**
 * What the agent sees beyond the video (28.10): the event track (clicks and
 * moves inside Work, placed on the frame), a ring drawn into the video where
 * a click lands, and key frames grabbed live — at the start, ~¼ s after a
 * click (the ring and what the click did) and after the screen changes.
 * Driven by the compositing ticker (30 fps, also in a background tab).
 */
class AgentViewTracker {
  readonly events: RecordingEvent[] = [];
  readonly frames: LiveKeyFrame[] = [];
  private ripples: Array<{ x: number; y: number; at: number }> = [];
  private pointer: { x: number; y: number; at: number } | null = null;
  private pending: Array<{ due: number; reason: KeyFrameReason }> = [];
  private readonly encoding = new Set<Promise<void>>();
  private lastMoveAt = -Infinity;
  private lastSceneAt = -Infinity;
  private prevLuma: Float32Array | null = null;
  private ticks = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly snapSize: { width: number; height: number };

  constructor(
    private readonly env: RecorderEnv,
    private readonly screenVideo: HTMLVideoElement,
    private readonly frame: { width: number; height: number },
    private readonly surface: DisplaySurface,
    private readonly elapsed: () => number,
    private readonly recording: () => boolean,
    private readonly snapCanvas: HTMLCanvasElement,
    private readonly lumaCanvas: HTMLCanvasElement | null,
  ) {
    const scale = Math.min(1, KEY_FRAME_MAX_WIDTH / Math.max(1, frame.width));
    this.snapSize = {
      width: Math.max(2, Math.round(frame.width * scale)),
      height: Math.max(2, Math.round(frame.height * scale)),
    };
    snapCanvas.width = this.snapSize.width;
    snapCanvas.height = this.snapSize.height;
    if (lumaCanvas) {
      lumaCanvas.width = 32;
      lumaCanvas.height = 18;
    }
    this.pending.push({ due: 800, reason: "start" });
    try {
      this.unsubscribe = env.subscribePointer?.((sample) => this.onSample(sample)) ?? null;
    } catch {
      this.unsubscribe = null;
    }
  }

  private push(event: RecordingEvent) {
    if (this.events.length < RECORDING_EVENTS_MAX) this.events.push(event);
  }

  onSample(sample: PointerSample) {
    if (!this.recording()) return;
    const t = this.elapsed();
    let at: { x: number; y: number } | null = null;
    try {
      const view = this.env.viewport?.();
      at = view ? mapPointerToFrame(sample, this.surface, view, this.frame) : null;
    } catch {
      at = null;
    }
    if (at) this.pointer = { x: at.x, y: at.y, at: this.env.now() };
    if (sample.kind === "move") {
      if (!at || t - this.lastMoveAt < MOVE_SAMPLE_MS) return;
      this.lastMoveAt = t;
      this.push({ t, kind: "move", x: at.x, y: at.y });
      return;
    }
    this.push(at ? { t, kind: "click", x: at.x, y: at.y } : { t, kind: "click" });
    if (at) this.ripples.push({ x: at.x, y: at.y, at: this.env.now() });
    this.pending.push({ due: t + CLICK_FRAME_DELAY_MS, reason: "click" });
  }

  /** The rings of recent clicks, on a frame of width×height. */
  drawRipples(context: CanvasRenderingContext2D, width: number, height: number) {
    if (this.ripples.length === 0) return;
    const now = this.env.now();
    this.ripples = this.ripples.filter((ripple) => now - ripple.at < RIPPLE_MS);
    const unit = Math.max(1, width / 1280);
    for (const ripple of this.ripples) {
      const age = (now - ripple.at) / RIPPLE_MS;
      const cx = ripple.x * width;
      const cy = ripple.y * height;
      context.save();
      context.beginPath();
      context.arc(cx, cy, (12 + 30 * age) * unit, 0, Math.PI * 2);
      context.lineWidth = 4 * unit;
      context.strokeStyle = `rgba(255, 196, 0, ${(1 - age * 0.8).toFixed(3)})`;
      context.stroke();
      context.beginPath();
      context.arc(cx, cy, 5 * unit, 0, Math.PI * 2);
      context.fillStyle = `rgba(255, 196, 0, ${(0.9 - age * 0.6).toFixed(3)})`;
      context.fill();
      context.restore();
    }
  }

  /**
   * A shared tab has no mouse pointer in it (screens and windows do): Work
   * draws the arrow where its own page last saw the pointer (≤ 5 s ago).
   */
  drawPointer(context: CanvasRenderingContext2D, width: number, height: number) {
    const pointer = this.pointer;
    if (this.surface !== "browser" || !pointer || this.env.now() - pointer.at > 5000) return;
    const unit = Math.max(1, width / 1280) * 1.4;
    const x = pointer.x * width;
    const y = pointer.y * height;
    context.save();
    context.translate(x, y);
    context.scale(unit, unit);
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(0, 17);
    context.lineTo(4.2, 13);
    context.lineTo(7.2, 19.6);
    context.lineTo(10, 18.4);
    context.lineTo(7.1, 11.9);
    context.lineTo(12.6, 11.9);
    context.closePath();
    context.fillStyle = "#ffffff";
    context.fill();
    context.lineWidth = 1.2;
    context.strokeStyle = "#000000";
    context.stroke();
    context.restore();
  }

  /** The agent's picture (≤ 1280 px, no camera circle): the screen, the pointer, click rings. */
  private drawAgentFrame(): boolean {
    try {
      const context = this.snapCanvas.getContext("2d") as CanvasRenderingContext2D | null;
      if (!context) return false;
      const { width, height } = this.snapSize;
      context.drawImage(this.screenVideo, 0, 0, width, height);
      this.drawRipples(context, width, height);
      this.drawPointer(context, width, height);
      return true;
    } catch {
      return false;
    }
  }

  /** Every compositing tick: due key frames, and twice a second a look for a new screen. */
  tick() {
    this.ticks += 1;
    // The agent copy is this canvas at 5 fps (30 fps ticks).
    if (this.ticks % 6 === 0) this.drawAgentFrame();
    if (!this.recording()) return;
    const now = this.elapsed();
    const due = this.pending.filter((item) => item.due <= now);
    if (due.length > 0) {
      this.pending = this.pending.filter((item) => item.due > now);
      // One picture for everything due at once; the most telling reason names it.
      const reason = due.some((item) => item.reason === "click")
        ? "click"
        : due.some((item) => item.reason === "scene")
          ? "scene"
          : due[0]!.reason;
      this.snap(reason, now);
    }
    if (this.lumaCanvas && this.ticks % 15 === 0) this.lookForNewScreen(now);
  }

  private lookForNewScreen(now: number) {
    try {
      const context = this.lumaCanvas!.getContext("2d", {
        willReadFrequently: true,
      } as never) as CanvasRenderingContext2D | null;
      if (!context) return;
      context.drawImage(this.screenVideo, 0, 0, 32, 18);
      const data = context.getImageData(0, 0, 32, 18).data;
      const luma = new Float32Array(32 * 18);
      for (let i = 0; i < luma.length; i += 1) {
        luma[i] = 0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!;
      }
      const prev = this.prevLuma;
      this.prevLuma = luma;
      if (!prev) return;
      let sum = 0;
      for (let i = 0; i < luma.length; i += 1) sum += Math.abs(luma[i]! - prev[i]!);
      const change = sum / luma.length;
      if (change < SCENE_CHANGE_THRESHOLD || now - this.lastSceneAt < SCENE_MIN_GAP_MS) return;
      this.lastSceneAt = now;
      this.push({ t: now, kind: "scene" });
      this.pending.push({ due: now + SCENE_SETTLE_MS, reason: "scene" });
    } catch {
      // A tainted or lost canvas: no scene detection, the rest goes on.
    }
  }

  private snap(reason: KeyFrameReason, t: number) {
    if (this.frames.length + this.encoding.size >= LIVE_KEY_FRAMES_MAX) {
      if (reason === "scene" || reason === "start") return;
      // A click is worth more than a screen change: make room.
      const index = this.frames.findIndex((frame) => frame.reason === "scene");
      if (index === -1) return;
      this.frames.splice(index, 1);
    }
    const encode = this.env.encodeJpeg;
    if (!encode || !this.drawAgentFrame()) return;
    const job = encode(this.snapCanvas)
      .then((blob) => {
        if (blob && blob.size > 0)
          this.frames.push({
            t,
            reason,
            blob,
            width: this.snapSize.width,
            height: this.snapSize.height,
          });
      })
      .catch(() => undefined)
      .finally(() => this.encoding.delete(job));
    this.encoding.add(job);
  }

  async finish(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await Promise.all([...this.encoding]);
    this.frames.sort((a, b) => a.t - b.t);
  }

  detach() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
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
      /** Set right after construction (it needs the recorder's clock). */
      tracker: AgentViewTracker | null;
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
      await this.parts.tracker?.finish().catch(() => undefined);
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
        events: this.parts.tracker ? [...this.parts.tracker.events] : [],
        keyFrames: this.parts.tracker ? [...this.parts.tracker.frames] : [],
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
    this.parts.tracker?.detach();
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

      // Video: the screen as is, or composited on a canvas: + the camera
      // circle, + a ring where a click lands (when Work follows the pointer).
      let videoTrack: MediaStreamTrack = screenTrack;
      const tracking = Boolean(env.encodeJpeg && env.subscribePointer);
      const canvas = camera || tracking ? env.createCanvas() : null;
      if (camera && !canvas) {
        events.onWarning?.("The camera circle isn't available here — recording the screen only.");
        stopAll(camera);
        camera = null;
      }
      let makeTracker: ((recorder: ScreenRecorder) => AgentViewTracker) | null = null;
      /** The agent copy from Work's own small canvas (pointer + click rings in it). */
      let agentCanvasTrack: MediaStreamTrack | null = null;
      const holder: { tracker: AgentViewTracker | null } = { tracker: null };
      if (canvas) {
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        const cameraStream = camera;
        const [screenVideo, cameraVideo] = await Promise.all([
          env.createVideo(new MediaStream([screenTrack])),
          cameraStream ? env.createVideo(cameraStream) : Promise.resolve(null),
        ]);
        if (tracking) {
          const snapCanvas = env.createCanvas();
          const lumaCanvas = env.createCanvas();
          const rawSurface = (settings as { displaySurface?: string }).displaySurface;
          const surface: DisplaySurface =
            rawSurface === "monitor" || rawSurface === "window" || rawSurface === "browser"
              ? rawSurface
              : "unknown";
          if (snapCanvas) {
            const scale = Math.min(1, KEY_FRAME_MAX_WIDTH / Math.max(1, size.width));
            snapCanvas.width = Math.max(2, Math.round(size.width * scale));
            snapCanvas.height = Math.max(2, Math.round(size.height * scale));
            try {
              const agentStream = snapCanvas.captureStream(5);
              extra.push(agentStream);
              agentCanvasTrack = agentStream.getVideoTracks()[0] ?? null;
            } catch {
              agentCanvasTrack = null;
            }
            makeTracker = (recorder) =>
              new AgentViewTracker(
                env,
                screenVideo,
                size,
                // Electron's picker doesn't say: a screen of the same shape is assumed.
                surface === "unknown" ? "monitor" : surface,
                () => recorder.elapsedMs(),
                () => recorder.state === "recording",
                snapCanvas,
                lumaCanvas,
              );
          }
        }
        const bubble = cameraBubbleRect(size.width, size.height);
        const drawBubble = (context: CanvasRenderingContext2D, cameraVideo: HTMLVideoElement) => {
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
        const draw = () => {
          if (!context) return;
          context.drawImage(screenVideo, 0, 0, size.width, size.height);
          holder.tracker?.drawRipples(context, size.width, size.height);
          holder.tracker?.drawPointer(context, size.width, size.height);
          if (cameraVideo) drawBubble(context, cameraVideo);
          holder.tracker?.tick();
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
        let small: MediaStreamTrack;
        if (agentCanvasTrack) {
          small = agentCanvasTrack;
        } else {
          small = screenTrack.clone();
          await small
            .applyConstraints({ width: { max: 1280 }, frameRate: { max: 5 } })
            .catch(() => undefined);
        }
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
        tracker: null,
      });
      if (makeTracker) {
        try {
          holder.tracker = makeTracker(recorder);
          recorder.parts.tracker = holder.tracker;
        } catch {
          holder.tracker = null;
        }
      }
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

/** Clicks and moves anywhere in Work's page (capture phase: nothing hides them). */
function documentPointer(onSample: (sample: PointerSample) => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  // The recording's own controls (the bar, the popup) are not what is shown.
  const ownControls = '[data-testid="recording-bar"],[data-testid="record-popup"]';
  const handler = (kind: "click" | "move") => (event: PointerEvent) => {
    if (kind === "click" && event.button !== 0) return;
    const target = event.target as Element | null;
    if (kind === "click" && typeof target?.closest === "function" && target.closest(ownControls)) {
      return;
    }
    onSample({
      kind,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
    });
  };
  const down = handler("click");
  const move = handler("move");
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointermove", move, { capture: true, passive: true });
  return () => {
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointermove", move, true);
  };
}

function browserViewport(): ViewportInfo {
  const screenInfo = window.screen as Screen & {
    left?: number;
    top?: number;
    availLeft?: number;
    availTop?: number;
  };
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth || window.innerWidth,
    outerHeight: window.outerHeight || window.innerHeight,
    screenWidth: screenInfo.width,
    screenHeight: screenInfo.height,
    screenLeft: screenInfo.left ?? screenInfo.availLeft ?? 0,
    screenTop: screenInfo.top ?? screenInfo.availTop ?? 0,
  };
}

function canvasJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.82);
    } catch {
      resolve(null);
    }
  });
}

export function browserRecorderEnv(platform: { mac: boolean; desktopApp: boolean }): RecorderEnv {
  return {
    subscribePointer: documentPointer,
    viewport: browserViewport,
    encodeJpeg: canvasJpeg,
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
