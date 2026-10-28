import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineDeps } from "./pipeline";
import type { RecordingResult } from "./recorder";

// A fake engine: the store's job is the session, the cards and the pipeline.
const engine = vi.hoisted(() => ({
  startError: null as unknown,
  elapsed: 0,
  events: null as { onSourceEnded?: () => void; onWarning?: (m: string) => void } | null,
  stopped: 0,
  cancelled: 0,
  hasVoice: true,
  ticks: 0,
  result: null as RecordingResult | null,
}));

vi.mock("./recorder", async () => {
  const actual = await vi.importActual<typeof import("./recorder")>("./recorder");
  class FakeScreenRecorder {
    state = "recording";
    cameraStream = null;
    get hasVoice() {
      return engine.hasVoice;
    }
    get hasMicrophone() {
      return engine.hasVoice;
    }
    static async start(_options: unknown, _env: unknown, events: typeof engine.events) {
      if (engine.startError) throw engine.startError;
      engine.events = events;
      return new FakeScreenRecorder();
    }
    elapsedMs() {
      return engine.elapsed;
    }
    tick() {
      engine.ticks += 1;
    }
    pause() {
      this.state = "paused";
    }
    resume() {
      this.state = "recording";
    }
    async stop() {
      engine.stopped += 1;
      return engine.result!;
    }
    cancel() {
      engine.cancelled += 1;
    }
  }
  return { ...actual, ScreenRecorder: FakeScreenRecorder };
});

const { CaptureError } = await import("./recorder");
const {
  configureRecordingRuntime,
  resetScreenRecordingStoreForTests,
  useScreenRecordingStore,
  localRecordingUrl,
} = await import("./recordingStore");

const notices: Array<{ kind: string; title: string; description?: string }> = [];
let describeImpl: PipelineDeps["describe"];

function deps(): PipelineDeps {
  return {
    homePath: async () => "/home/me",
    writeFile: async () => ({}),
    driveState: async () => ({
      available: true,
      message: null,
      bucketId: 1,
      usedBytes: 0,
      quotaBytes: 0,
    }),
    copyToCloud: async () => ({ files: 1, skipped: [] }),
    shareCreate: async () => ({ url: "https://api.getuno.xyz/d/tok" }),
    describe: (input) => describeImpl(input),
    removePaths: async () => ({}),
    deleteCloud: async () => ({}),
  };
}

const store = () => useScreenRecordingStore.getState();
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  resetScreenRecordingStoreForTests();
  notices.length = 0;
  Object.assign(engine, {
    startError: null,
    elapsed: 0,
    events: null,
    stopped: 0,
    cancelled: 0,
    hasVoice: true,
    ticks: 0,
  });
  engine.result = {
    blob: new Blob([new Uint8Array(2048)], { type: "video/mp4" }),
    mimeType: "video/mp4",
    durationMs: 12_000,
    agentParts: [
      { blob: new Blob([new Uint8Array(512)], { type: "video/mp4" }), durationMs: 12_000 },
    ],
    agentCopyMimeType: "video/mp4",
    width: 1920,
    height: 1080,
    hasVoice: true,
    hasCamera: true,
  };
  describeImpl = async () => ({ speech: "Rename the button to Start", visual: "A form" });
  let n = 0;
  configureRecordingRuntime({
    env: () => ({}) as never,
    deps,
    notify: (notice) => notices.push(notice),
    createObjectUrl: () => `blob:rec-${(n += 1)}`,
    revokeObjectUrl: () => undefined,
    newId: () => `id-${n}`,
    now: () => new Date(2026, 9, 28, 14, 5, 7),
  });
});
afterEach(() => vi.useRealTimers());

describe("a session", () => {
  it("start → Done → a card for that chat, saved and watched", async () => {
    expect(await store().start({ threadKey: "t1", environmentId: "e1" })).toBe(true);
    expect(store().session.phase).toBe("recording");
    await store().stop();
    expect(store().session.phase).toBe("idle");
    const item = store().items["t1"]!;
    expect(item.name).toBe("Screen recording 2026-10-28 at 14.05.07.mp4");
    await flush();
    const done = store().items["t1"]!;
    expect(done.save).toMatchObject({ status: "done", shareUrl: "https://api.getuno.xyz/d/tok" });
    expect(done.watch).toMatchObject({ status: "done", speech: "Rename the button to Start" });
  });

  it("only one recording at a time", async () => {
    await store().start({ threadKey: "t1", environmentId: "e1" });
    expect(await store().start({ threadKey: "t2", environmentId: "e1" })).toBe(false);
  });

  it("a closed picker goes back quietly", async () => {
    engine.startError = new CaptureError({ kind: "cancelled", message: null });
    expect(await store().start({ threadKey: "t1", environmentId: "e1" })).toBe(false);
    expect(store().session.phase).toBe("idle");
    expect(notices).toHaveLength(0);
  });

  it("a blocked screen says why", async () => {
    engine.startError = new CaptureError({
      kind: "denied",
      message: "macOS blocks screen recording…",
    });
    await store().start({ threadKey: "t1", environmentId: "e1" });
    expect(notices[0]).toMatchObject({
      kind: "error",
      description: "macOS blocks screen recording…",
    });
  });

  it("knows whether the microphone is in (the bar says 'no mic')", async () => {
    engine.hasVoice = false;
    await store().start({ threadKey: "t1", environmentId: "e1" });
    expect(store().session.hasMicrophone).toBe(false);
  });

  it("pause / resume", async () => {
    await store().start({ threadKey: "t1", environmentId: "e1" });
    store().pause();
    expect(store().session.phase).toBe("paused");
    store().resume();
    expect(store().session.phase).toBe("recording");
  });

  it("the browser's Stop sharing finishes it like Done", async () => {
    await store().start({ threadKey: "t1", environmentId: "e1" });
    engine.events?.onSourceEnded?.();
    await flush();
    expect(engine.stopped).toBe(1);
    expect(store().items["t1"]).toBeDefined();
  });

  it("stops by itself at 60 minutes and says so", async () => {
    vi.useFakeTimers();
    await store().start({ threadKey: "t1", environmentId: "e1" });
    engine.elapsed = 60 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(600);
    expect(engine.stopped).toBe(1);
    expect(notices.some((n) => n.title === "Stopped at 60 minutes")).toBe(true);
  });

  it("keeps the recorder ticking (it cuts the agent copy into parts)", async () => {
    vi.useFakeTimers();
    await store().start({ threadKey: "t1", environmentId: "e1" });
    engine.elapsed = 6 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(engine.ticks).toBeGreaterThan(1);
    expect(engine.stopped).toBe(0);
  });

  it("Discard leaves no card", async () => {
    await store().start({ threadKey: "t1", environmentId: "e1" });
    store().cancel();
    expect(engine.cancelled).toBe(1);
    expect(store().session.phase).toBe("idle");
    expect(store().items["t1"]).toBeUndefined();
  });

  it("an empty recording is an error, not a card", async () => {
    engine.result = { ...engine.result!, blob: new Blob([]) };
    await store().start({ threadKey: "t1", environmentId: "e1" });
    await store().stop();
    expect(store().items["t1"]).toBeUndefined();
    expect(notices.some((n) => n.title === "Nothing was recorded")).toBe(true);
  });
});

describe("the card", () => {
  async function recorded() {
    await store().start({ threadKey: "t1", environmentId: "e1" });
    await store().stop();
    await flush();
  }

  it("Retry watch after a failure", async () => {
    let fail = true;
    describeImpl = async () => {
      if (fail) throw new Error("gateway timeout");
      return { speech: "ok", visual: "" };
    };
    await recorded();
    expect(store().items["t1"]!.watch).toMatchObject({
      status: "failed",
      error: "gateway timeout",
    });
    fail = false;
    store().retryWatch("t1");
    await flush();
    expect(store().items["t1"]!.watch).toMatchObject({ status: "done", speech: "ok" });
  });

  it("take: the block for the agent, the card goes, the preview stays playable", async () => {
    await recorded();
    const taken = store().take("t1");
    expect(taken?.forAgent).toMatchObject({
      driveKey: "Recordings/Screen recording 2026-10-28 at 14.05.07.mp4",
      speech: "Rename the button to Start",
    });
    expect(store().items["t1"]).toBeUndefined();
    expect(localRecordingUrl(taken!.forAgent.name)).toMatch(/^blob:/);
    // The send failed: the card comes back.
    store().restore(taken!.item);
    expect(store().items["t1"]).toBeDefined();
  });

  it("take refuses while still working", async () => {
    describeImpl = () => new Promise(() => undefined);
    await recorded();
    expect(store().take("t1")).toBeNull();
  });

  it("prefilled only once", async () => {
    await recorded();
    store().markPrefilled("t1");
    store().markPrefilled("t1");
    expect(store().items["t1"]!.prefilled).toBe(true);
  });

  it("a new recording in the same chat replaces the card", async () => {
    await recorded();
    const first = store().items["t1"]!.id;
    await recorded();
    expect(store().items["t1"]!.id).not.toBe(first);
  });

  it("remove", async () => {
    await recorded();
    store().remove("t1");
    expect(store().items["t1"]).toBeUndefined();
  });
});
