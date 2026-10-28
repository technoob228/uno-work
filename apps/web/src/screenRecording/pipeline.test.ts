import { describe, expect, it, vi } from "vitest";

import {
  INITIAL_SAVE,
  INITIAL_WATCH,
  type PipelineDeps,
  type RecordingItem,
  recordingReadiness,
  runPipeline,
  runSave,
  runWatch,
  watchSkipReason,
} from "./pipeline";

function item(overrides: Partial<RecordingItem> = {}): RecordingItem {
  const blob = new Blob([new Uint8Array(5 * 1024 * 1024)], { type: "video/mp4" });
  return {
    id: "rec1",
    threadKey: "thread-1",
    environmentId: "env-1",
    name: "Screen recording 2026-10-28 at 14.05.07.mp4",
    mimeType: "video/mp4",
    sizeBytes: blob.size,
    durationMs: 42_000,
    blob,
    previewUrl: "blob:preview",
    agentParts: [
      { blob: new Blob([new Uint8Array(300_000)], { type: "video/mp4" }), durationMs: 42_000 },
    ],
    agentCopyMimeType: "video/mp4",
    hasVoice: true,
    width: 1280,
    height: 720,
    events: [],
    liveFrames: [],
    createdAt: "2026-10-28T14:05:07Z",
    save: INITIAL_SAVE,
    watch: INITIAL_WATCH,
    prefilled: false,
    ...overrides,
  };
}

function deps(overrides: Partial<PipelineDeps> = {}) {
  const writes: Array<{ cwd: string; relativePath: string; mode?: string; bytes: number }> = [];
  const base: PipelineDeps = {
    homePath: vi.fn(async () => "/home/me"),
    writeFile: vi.fn(async (input) => {
      writes.push({
        cwd: input.cwd,
        relativePath: input.relativePath,
        ...(input.mode ? { mode: input.mode } : {}),
        bytes: Buffer.from(input.contents, "base64").byteLength,
      });
      return {};
    }),
    driveState: vi.fn(async () => ({
      available: true,
      message: null,
      bucketId: 77,
      usedBytes: 0,
      quotaBytes: 10 * 1024 ** 3,
    })),
    copyToCloud: vi.fn(async () => ({ files: 1, skipped: [] })),
    shareCreate: vi.fn(async () => ({ url: "https://api.getuno.xyz/d/tok" })),
    describe: vi.fn(async () => ({ speech: "Make it green", visual: "A landing page" })),
    removePaths: vi.fn(async () => ({})),
    deleteCloud: vi.fn(async () => ({})),
    ...overrides,
  };
  return { deps: base, writes };
}

function collect<T extends object>() {
  const updates: Partial<T>[] = [];
  return {
    updates,
    patch: (update: Partial<T>) => updates.push(update),
    last: () => Object.assign({}, ...updates) as Partial<T>,
  };
}

describe("Save — the video into Uno Drive", () => {
  it("stages it in chunks, moves it to Recordings/ and makes a link", async () => {
    const { deps: d, writes } = deps();
    const save = collect<RecordingItem["save"]>();
    await runSave(item(), d, save.patch);
    // 5 MB in 3 MB chunks: replace, then append.
    expect(writes.map((w) => w.mode ?? "replace")).toEqual(["replace", "append"]);
    expect(writes.reduce((sum, w) => sum + w.bytes, 0)).toBe(5 * 1024 * 1024);
    expect(writes[0]!.relativePath).toBe(
      ".uno-recordings/rec1/Screen recording 2026-10-28 at 14.05.07.mp4",
    );
    expect(d.copyToCloud).toHaveBeenCalledWith({
      paths: ["/home/me/.uno-recordings/rec1/Screen recording 2026-10-28 at 14.05.07.mp4"],
      bucketId: 77,
      prefix: "Recordings/",
      removeSource: true,
    });
    expect(save.last()).toMatchObject({
      status: "done",
      progress: 1,
      driveKey: "Recordings/Screen recording 2026-10-28 at 14.05.07.mp4",
      shareUrl: "https://api.getuno.xyz/d/tok",
    });
    // Progress went up before done.
    expect(
      save.updates.some((u) => u.progress !== undefined && u.progress > 0 && u.progress < 1),
    ).toBe(true);
  });

  it("a full Drive fails before sending a byte", async () => {
    const { deps: d, writes } = deps({
      driveState: async () => ({
        available: true,
        message: null,
        bucketId: 77,
        usedBytes: 10 * 1024 ** 3,
        quotaBytes: 10 * 1024 ** 3,
      }),
    });
    const save = collect<RecordingItem["save"]>();
    await runSave(item(), d, save.patch);
    expect(writes).toHaveLength(0);
    expect(save.last()).toMatchObject({ status: "failed" });
    expect(save.last().error).toContain("Uno Drive is full");
  });

  it("a broken upload fails with Retry-able state and removes the half file", async () => {
    let calls = 0;
    const { deps: d } = deps({
      writeFile: async () => {
        calls += 1;
        if (calls === 2) throw new Error("socket closed");
        return {};
      },
    });
    const save = collect<RecordingItem["save"]>();
    await runSave(item(), d, save.patch);
    expect(save.last()).toMatchObject({ status: "failed", error: "socket closed" });
    // The staged path wasn't known yet (write failed mid-way): nothing to move.
    expect(d.copyToCloud).not.toHaveBeenCalled();
  });

  it("Drive refusing the file is an error, and the staged copy is removed", async () => {
    const { deps: d } = deps({
      copyToCloud: async () => ({
        files: 0,
        skipped: [{ name: "x.mp4", reason: "over the size limit" }],
      }),
    });
    const save = collect<RecordingItem["save"]>();
    await runSave(item(), d, save.patch);
    expect(save.last()).toMatchObject({ status: "failed" });
    expect(save.last().error).toContain("over the size limit");
    expect(d.removePaths).toHaveBeenCalledWith([
      "/home/me/.uno-recordings/rec1/Screen recording 2026-10-28 at 14.05.07.mp4",
    ]);
  });

  it("no share link is not a failure: the file is safe in Drive", async () => {
    const { deps: d } = deps({
      shareCreate: async () => {
        throw new Error("RATE_LIMITED");
      },
    });
    const save = collect<RecordingItem["save"]>();
    await runSave(item(), d, save.patch);
    expect(save.last()).toMatchObject({ status: "done", shareUrl: null });
  });

  it("stops when aborted (the card was removed)", async () => {
    const { deps: d } = deps();
    const controller = new AbortController();
    controller.abort();
    const save = collect<RecordingItem["save"]>();
    await runSave(item(), d, save.patch, controller.signal);
    expect(save.last().status).toBe("failed");
    expect(d.copyToCloud).not.toHaveBeenCalled();
  });
});

describe("Watch — the agent copy through /video/describe", () => {
  it("stages the small copy, asks the daemon, removes the copy", async () => {
    const { deps: d, writes } = deps();
    const watch = collect<RecordingItem["watch"]>();
    await runWatch(item(), d, watch.patch);
    expect(writes[0]!.relativePath).toBe(".uno-recordings/rec1/agent-copy.mp4");
    expect(d.describe).toHaveBeenCalledWith({
      path: "/home/me/.uno-recordings/rec1/agent-copy.mp4",
      mimeType: "video/mp4",
      durationSec: 42,
      mode: "timeline",
    });
    expect(watch.last()).toMatchObject({
      status: "done",
      speech: "Make it green",
      visual: "A landing page",
    });
    expect(d.removePaths).toHaveBeenCalledWith(["/home/me/.uno-recordings/rec1/agent-copy.mp4"]);
  });

  it("skips (not fails) when there is no copy, it is too big or too long", () => {
    expect(watchSkipReason(item({ agentParts: [] }))).toContain("couldn't make");
    expect(
      watchSkipReason(
        item({
          agentParts: [{ blob: new Blob([new Uint8Array(26 * 1024 * 1024)]), durationMs: 42_000 }],
        }),
      ),
    ).toContain("too big");
    expect(watchSkipReason(item({ durationMs: 61 * 60 * 1000 }))).toContain("60 minutes");
    // 40 minutes is fine now: it goes part by part.
    expect(watchSkipReason(item({ durationMs: 40 * 60 * 1000 }))).toBeNull();
    expect(watchSkipReason(item())).toBeNull();
  });

  it("a gateway error is shown as is and the copy is still removed", async () => {
    const { deps: d } = deps({
      describe: async () => {
        throw Object.assign(new Error(""), {
          message: "You've used today's free dictation. Top up AI hours to continue.",
        });
      },
    });
    const watch = collect<RecordingItem["watch"]>();
    await runWatch(item(), d, watch.patch);
    expect(watch.last()).toMatchObject({ status: "failed" });
    expect(watch.last().error).toContain("Top up AI hours");
    expect(d.removePaths).toHaveBeenCalled();
  });
});

describe("Watch — a long recording, part by part through Uno Drive", () => {
  const part = (seconds: number) => ({
    blob: new Blob([new Uint8Array(200_000)], { type: "video/webm" }),
    durationMs: seconds * 1000,
  });
  const long = () =>
    item({
      durationMs: 12 * 60 * 1000 + 30_000,
      agentCopyMimeType: "video/webm",
      agentParts: [part(300), part(300), part(150)],
    });

  it("stages the parts, moves them to Drive, asks with their keys, deletes them after", async () => {
    const { deps: d, writes } = deps({
      copyToCloud: vi.fn(async () => ({ files: 3, skipped: [] })),
    });
    const watch = collect<RecordingItem["watch"]>();
    await runWatch(long(), d, watch.patch);
    expect(writes.map((w) => w.relativePath)).toEqual([
      ".uno-recordings/rec1/agent/part-01.webm",
      ".uno-recordings/rec1/agent/part-02.webm",
      ".uno-recordings/rec1/agent/part-03.webm",
    ]);
    expect(d.copyToCloud).toHaveBeenCalledWith({
      paths: [
        "/home/me/.uno-recordings/rec1/agent/part-01.webm",
        "/home/me/.uno-recordings/rec1/agent/part-02.webm",
        "/home/me/.uno-recordings/rec1/agent/part-03.webm",
      ],
      bucketId: 77,
      prefix: "Recordings/.agent-rec1/",
      removeSource: true,
    });
    expect(d.describe).toHaveBeenCalledWith({
      driveParts: [
        { key: "Recordings/.agent-rec1/part-01.webm", durationSec: 300 },
        { key: "Recordings/.agent-rec1/part-02.webm", durationSec: 300 },
        { key: "Recordings/.agent-rec1/part-03.webm", durationSec: 150 },
      ],
      mimeType: "video/webm",
      durationSec: 750,
      mode: "timeline",
    });
    expect(watch.last()).toMatchObject({ status: "done", speech: "Make it green" });
    expect(d.deleteCloud).toHaveBeenCalledWith({ bucketId: 77, key: "Recordings/.agent-rec1/" });
    // Moved with removeSource: nothing left to remove on the computer.
    expect(d.removePaths).not.toHaveBeenCalled();
  });

  it("a full Drive fails before sending a byte, with a reason", async () => {
    const { deps: d, writes } = deps({
      driveState: async () => ({
        available: true,
        message: null,
        bucketId: 77,
        usedBytes: 10 * 1024 ** 3,
        quotaBytes: 10 * 1024 ** 3,
      }),
    });
    const watch = collect<RecordingItem["watch"]>();
    await runWatch(long(), d, watch.patch);
    expect(writes).toHaveLength(0);
    expect(watch.last().status).toBe("failed");
    expect(watch.last().error).toContain("through Uno Drive");
    expect(d.describe).not.toHaveBeenCalled();
  });

  it("a gateway error still deletes the parts from Drive", async () => {
    const { deps: d } = deps({
      copyToCloud: vi.fn(async () => ({ files: 3, skipped: [] })),
      describe: async () => {
        throw new Error("Part 2 of the recording: the gateway took too long.");
      },
    });
    const watch = collect<RecordingItem["watch"]>();
    await runWatch(long(), d, watch.patch);
    expect(watch.last()).toMatchObject({ status: "failed" });
    expect(watch.last().error).toContain("Part 2");
    expect(d.deleteCloud).toHaveBeenCalledWith({ bucketId: 77, key: "Recordings/.agent-rec1/" });
  });

  it("Drive taking fewer parts than sent is an error", async () => {
    const { deps: d } = deps({ copyToCloud: vi.fn(async () => ({ files: 2, skipped: [] })) });
    const watch = collect<RecordingItem["watch"]>();
    await runWatch(long(), d, watch.patch);
    expect(watch.last().status).toBe("failed");
    expect(d.describe).not.toHaveBeenCalled();
    expect(d.deleteCloud).toHaveBeenCalled();
  });
});

describe("both steps", () => {
  it("run side by side and leave no staging folder", async () => {
    const { deps: d } = deps();
    const updates: unknown[] = [];
    await runPipeline(item(), d, (u) => updates.push(u));
    expect(d.removePaths).toHaveBeenLastCalledWith(["/home/me/.uno-recordings/rec1"]);
    expect(updates.length).toBeGreaterThan(3);
  });
});

describe("can the card go with the message", () => {
  const done = { ...INITIAL_SAVE, status: "done" as const };
  const watched = { ...INITIAL_WATCH, status: "done" as const };
  it("waits while saving or watching", () => {
    expect(recordingReadiness(item({ save: done }))).toMatchObject({ ready: false, busy: true });
    expect(recordingReadiness(item({ watch: watched })).blocking).toContain("saved");
  });
  it("is ready when both are done, or watch skipped", () => {
    expect(recordingReadiness(item({ save: done, watch: watched })).ready).toBe(true);
    expect(
      recordingReadiness(item({ save: done, watch: { ...INITIAL_WATCH, status: "skipped" } }))
        .ready,
    ).toBe(true);
  });
  it("a failed save with a watched recording still goes (the agent has the words)", () => {
    expect(
      recordingReadiness(item({ save: { ...INITIAL_SAVE, status: "failed" }, watch: watched }))
        .ready,
    ).toBe(true);
  });
  it("nothing saved and nothing watched: blocked with a way out", () => {
    const state = recordingReadiness(
      item({
        save: { ...INITIAL_SAVE, status: "failed" },
        watch: { ...INITIAL_WATCH, status: "failed" },
      }),
    );
    expect(state).toMatchObject({ ready: false, busy: false });
    expect(state.blocking).toContain("Retry");
  });
});

describe("Second by second (28.10): timeline, key frames, the event track", () => {
  const jpeg = (label: string) => new Blob([label], { type: "image/jpeg" });
  const live = (t: number, reason: "click" | "scene" | "start") => ({
    t,
    reason,
    blob: jpeg(`${reason}@${t}`),
    width: 1280,
    height: 720,
  });

  it("asks for the timeline with the clicks Work saw, in seconds", async () => {
    const { deps: d } = deps();
    await runWatch(
      item({
        events: [
          { t: 1000, kind: "move", x: 0.5, y: 0.5 },
          { t: 12_400, kind: "click", x: 0.83, y: 0.08 },
          { t: 20_000, kind: "scene" },
        ],
      }),
      d,
      () => undefined,
    );
    expect(d.describe).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "timeline",
        events: [{ t: 12.4, kind: "click", x: 0.83, y: 0.08 }],
      }),
    );
  });

  it("keeps the timeline and picks key frames: pointing words grabbed from the video, clicks live", async () => {
    const grabFrames = vi.fn(async (_blob: Blob, times: number[]) =>
      times.map((t) => ({ t, blob: jpeg(`grab@${t}`), width: 1280, height: 720 })),
    );
    const { deps: d } = deps({
      describe: vi.fn(async () => ({
        speech: "вот тут криво",
        visual: "A pricing page",
        timeline: [
          { t: 3, say: "смотри", see: "cursor on the header", do: "" },
          { t: 12.5, say: "вот тут криво", see: 'cursor on "Pricing" card, right', do: "" },
          { t: "junk", say: "x" },
        ],
      })),
      grabFrames,
    });
    const watch = collect<RecordingItem["watch"]>();
    await runWatch(
      item({ liveFrames: [live(800, "start"), live(5000, "click"), live(5600, "scene")] }),
      d,
      watch.patch,
    );
    const done = watch.last();
    expect(done.status).toBe("done");
    expect(done.timeline).toEqual([
      { t: 3, say: "смотри", see: "cursor on the header", do: "" },
      { t: 12.5, say: "вот тут криво", see: 'cursor on "Pricing" card, right', do: "" },
    ]);
    expect(grabFrames).toHaveBeenCalledWith(expect.any(Blob), [12_500], 1280);
    // The scene 0.6 s after the click is the same moment: the click stays.
    expect(done.frames!.map((frame) => [frame.t, frame.reason])).toEqual([
      [800, "start"],
      [5000, "click"],
      [12_500, "pointing"],
    ]);
  });

  it("a frame grab that fails leaves the live frames and the timeline", async () => {
    const { deps: d } = deps({
      describe: vi.fn(async () => ({
        speech: "this one",
        visual: "",
        timeline: [{ t: 2, say: "this one", see: "", do: "" }],
      })),
      grabFrames: vi.fn(async () => {
        throw new Error("decode failed");
      }),
    });
    const watch = collect<RecordingItem["watch"]>();
    await runWatch(item({ liveFrames: [live(800, "start")] }), d, watch.patch);
    expect(watch.last().status).toBe("done");
    expect(watch.last().frames!.map((frame) => frame.reason)).toEqual(["start"]);
  });

  it("an older gateway (no timeline): live frames still go", async () => {
    const { deps: d } = deps();
    const watch = collect<RecordingItem["watch"]>();
    await runWatch(item({ liveFrames: [live(800, "start"), live(9000, "click")] }), d, watch.patch);
    expect(watch.last().timeline).toEqual([]);
    expect(watch.last().frames).toHaveLength(2);
  });

  it("saves the event track next to the video in Recordings/", async () => {
    const { deps: d, writes } = deps();
    await runSave(
      item({ events: [{ t: 12_400, kind: "click", x: 0.83, y: 0.08 }] }),
      d,
      () => undefined,
    );
    const track = writes.find((write) => write.relativePath.endsWith(".events.json"));
    expect(track?.relativePath).toBe(
      ".uno-recordings/rec1/Screen recording 2026-10-28 at 14.05.07.events.json",
    );
    expect(d.copyToCloud).toHaveBeenCalledWith({
      paths: ["/home/me/.uno-recordings/rec1/Screen recording 2026-10-28 at 14.05.07.events.json"],
      bucketId: 77,
      prefix: "Recordings/",
      removeSource: true,
    });
  });

  it("no events: no track file", async () => {
    const { deps: d, writes } = deps();
    await runSave(item(), d, () => undefined);
    expect(writes.some((write) => write.relativePath.endsWith(".events.json"))).toBe(false);
  });
});
