import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CaptureError, type RecorderEnv, ScreenRecorder } from "./recorder";

// ── Fakes of what the browser gives ──────────────────────────────────────

class FakeTrack extends EventTarget {
  stopped = false;
  constraints: unknown = null;
  constructor(
    readonly kind: "video" | "audio",
    readonly label: string,
    private readonly settings: MediaTrackSettings = {},
  ) {
    super();
  }
  stop() {
    this.stopped = true;
  }
  clone() {
    return new FakeTrack(this.kind, `${this.label}-clone`, this.settings);
  }
  getSettings() {
    return this.settings;
  }
  async applyConstraints(constraints: unknown) {
    this.constraints = constraints;
  }
  end() {
    this.stopped = true;
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static supported = new Set(["video/webm;codecs=vp9,opus"]);
  static isTypeSupported(type: string) {
    return FakeRecorder.supported.has(type);
  }
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly mimeType: string;
  constructor(
    readonly stream: FakeStream,
    readonly options: MediaRecorderOptions = {},
  ) {
    this.mimeType = options.mimeType ?? "";
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  emit(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
  stop() {
    this.state = "inactive";
    this.emit(10);
    queueMicrotask(() => this.onstop?.());
  }
}

let clock = 0;
let ticks = 0;
let tickerStopped = false;

function makeEnv(overrides: Partial<RecorderEnv> & { screen?: FakeStream } = {}): RecorderEnv & {
  screen: FakeStream;
  camera: FakeStream;
  mic: FakeStream;
} {
  const screen =
    overrides.screen ??
    new FakeStream([new FakeTrack("video", "screen", { width: 2880, height: 1800 })]);
  const camera = new FakeStream([new FakeTrack("video", "camera")]);
  const mic = new FakeStream([new FakeTrack("audio", "mic")]);
  const canvasTrack = new FakeTrack("video", "canvas");
  const context = {
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    clip: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    stroke: vi.fn(),
    lineWidth: 0,
    strokeStyle: "",
  };
  return {
    screen,
    camera,
    mic,
    mediaDevices: {
      getDisplayMedia: vi.fn(async () => screen as unknown as MediaStream),
      getUserMedia: vi.fn(
        async (constraints?: MediaStreamConstraints) =>
          (constraints?.video ? camera : mic) as unknown as MediaStream,
      ),
    },
    MediaRecorder: FakeRecorder as unknown as RecorderEnv["MediaRecorder"],
    now: () => clock,
    createCanvas: () =>
      ({
        width: 0,
        height: 0,
        getContext: () => context,
        captureStream: () => new FakeStream([canvasTrack]),
      }) as unknown as HTMLCanvasElement,
    createVideo: async () => ({ videoWidth: 640, videoHeight: 480 }) as HTMLVideoElement,
    createTicker: (_fps, onTick) => {
      onTick();
      ticks += 1;
      return { stop: () => void (tickerStopped = true) };
    },
    mixAudio: (tracks) => ({
      track: new FakeTrack("audio", `mix-${tracks.length}`) as never,
      close: vi.fn(),
    }),
    ...overrides,
  };
}

beforeEach(() => {
  FakeRecorder.instances = [];
  FakeRecorder.supported = new Set(["video/webm;codecs=vp9,opus"]);
  clock = 1000;
  ticks = 0;
  tickerStopped = false;
  vi.stubGlobal("MediaStream", FakeStream);
});
afterEach(() => vi.unstubAllGlobals());

const options = { source: "screen" as const, camera: true, microphone: true };

describe("starting", () => {
  it("screen + camera circle on a canvas + voice, plus a small agent copy", async () => {
    const env = makeEnv();
    const recorder = await ScreenRecorder.start(options, env);
    expect(env.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(env.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(ticks).toBe(1);
    const [main, agent] = FakeRecorder.instances;
    expect(main!.stream.getVideoTracks()[0]!.label).toBe("canvas");
    expect(main!.stream.getAudioTracks()[0]!.label).toBe("mic");
    expect(main!.options.mimeType).toBe("video/webm;codecs=vp9,opus");
    expect(agent!.stream.getVideoTracks()[0]!.label).toBe("screen-clone");
    expect(agent!.stream.getVideoTracks()[0]!.constraints).toEqual({
      width: { max: 1280 },
      frameRate: { max: 5 },
    });
    expect(agent!.options.videoBitsPerSecond).toBeLessThan(main!.options.videoBitsPerSecond!);
    expect(recorder.cameraStream).toBe(env.camera);
    expect(recorder.hasVoice).toBe(true);
  });

  it("without the camera: the screen track goes straight to the recorder", async () => {
    const env = makeEnv();
    await ScreenRecorder.start({ ...options, camera: false }, env);
    expect(env.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(FakeRecorder.instances[0]!.stream.getVideoTracks()[0]!.label).toBe("screen");
    expect(ticks).toBe(0);
  });

  it("mixes tab sound with the voice", async () => {
    const screen = new FakeStream([
      new FakeTrack("video", "screen", { width: 1280, height: 720 }),
      new FakeTrack("audio", "tab-sound"),
    ]);
    const env = makeEnv({ screen });
    await ScreenRecorder.start(options, env);
    expect(FakeRecorder.instances[0]!.stream.getAudioTracks()[0]!.label).toBe("mix-2");
  });

  it("closing the picker throws a silent 'cancelled'", async () => {
    const env = makeEnv();
    env.mediaDevices.getDisplayMedia = vi.fn(async () => {
      throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    });
    const error = await ScreenRecorder.start(options, env).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CaptureError);
    expect((error as CaptureError).problem).toEqual({ kind: "cancelled", message: null });
    expect(env.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("macOS blocking screen recording explains where to allow it", async () => {
    const env = makeEnv({ platform: { mac: true, desktopApp: true } });
    env.mediaDevices.getDisplayMedia = vi.fn(async () => {
      throw Object.assign(new Error("Permission denied by system"), { name: "NotAllowedError" });
    });
    const error = (await ScreenRecorder.start(options, env).catch(
      (e: unknown) => e,
    )) as CaptureError;
    expect(error.problem.kind).toBe("denied");
    expect(error.problem.message).toContain("System Settings");
  });

  it("camera and microphone refused: records the screen anyway, says so", async () => {
    const env = makeEnv();
    env.mediaDevices.getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error(""), { name: "NotAllowedError" });
    });
    const warnings: string[] = [];
    const recorder = await ScreenRecorder.start(options, env, {
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("camera");
    expect(warnings[1]).toContain("microphone");
    expect(recorder.hasVoice).toBe(false);
    expect(recorder.hasMicrophone).toBe(false);
    expect(recorder.cameraStream).toBeNull();
    expect(FakeRecorder.instances[0]!.stream.getTracks()).toHaveLength(1);
  });

  it("no canvas (old engine): screen only, with a warning", async () => {
    const env = makeEnv({ createCanvas: () => null });
    const warnings: string[] = [];
    await ScreenRecorder.start(options, env, { onWarning: (m) => warnings.push(m) });
    expect(warnings[0]).toContain("camera circle");
    expect(env.camera.getTracks()[0]!.stopped).toBe(true);
  });

  it("a recorder failing to start releases the screen and the devices", async () => {
    const env = makeEnv({
      MediaRecorder: class {
        static isTypeSupported() {
          return false;
        }
        constructor() {
          throw new Error("no encoder");
        }
      } as unknown as RecorderEnv["MediaRecorder"],
    });
    const error = (await ScreenRecorder.start(options, env).catch(
      (e: unknown) => e,
    )) as CaptureError;
    expect(error.problem.message).toContain("no encoder");
    expect(env.screen.getTracks()[0]!.stopped).toBe(true);
    expect(env.mic.getTracks()[0]!.stopped).toBe(true);
    expect(tickerStopped).toBe(true);
  });
});

describe("recording", () => {
  it("time excludes pauses; pause/resume reach both recorders", async () => {
    const recorder = await ScreenRecorder.start(options, makeEnv());
    clock += 5000;
    recorder.pause();
    expect(FakeRecorder.instances.every((r) => r.state === "paused")).toBe(true);
    clock += 60_000;
    expect(recorder.elapsedMs()).toBe(5000);
    recorder.resume();
    clock += 2000;
    expect(recorder.elapsedMs()).toBe(7000);
    expect(FakeRecorder.instances.every((r) => r.state === "recording")).toBe(true);
  });

  it("stop hands over the video and the agent copy and frees everything", async () => {
    const env = makeEnv();
    const recorder = await ScreenRecorder.start(options, env);
    FakeRecorder.instances[0]!.emit(1000);
    FakeRecorder.instances[1]!.emit(100);
    clock += 3000;
    const result = await recorder.stop();
    expect(result.blob.size).toBe(1010);
    expect(result.mimeType).toBe("video/webm");
    expect(result.agentCopy?.size).toBe(110);
    expect(result.durationMs).toBe(3000);
    expect(result.width).toBe(1920);
    expect(result.hasCamera).toBe(true);
    expect(env.screen.getTracks()[0]!.stopped).toBe(true);
    expect(env.camera.getTracks()[0]!.stopped).toBe(true);
    expect(env.mic.getTracks()[0]!.stopped).toBe(true);
    expect(tickerStopped).toBe(true);
    // A second stop is the same result.
    expect(await recorder.stop()).toBe(result);
  });

  it("the browser's 'Stop sharing' tells the app", async () => {
    const env = makeEnv();
    const ended = vi.fn();
    await ScreenRecorder.start(options, env, { onSourceEnded: ended });
    env.screen.getTracks()[0]!.end();
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("cancel throws it all away", async () => {
    const env = makeEnv();
    const recorder = await ScreenRecorder.start(options, env);
    recorder.cancel();
    expect(recorder.state).toBe("stopped");
    expect(FakeRecorder.instances.every((r) => r.state === "inactive")).toBe(true);
    expect(env.screen.getTracks()[0]!.stopped).toBe(true);
  });
});
