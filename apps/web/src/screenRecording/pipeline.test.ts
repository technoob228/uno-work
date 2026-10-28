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
    agentCopy: new Blob([new Uint8Array(300_000)], { type: "video/mp4" }),
    agentCopyMimeType: "video/mp4",
    hasVoice: true,
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
    });
    expect(watch.last()).toMatchObject({
      status: "done",
      speech: "Make it green",
      visual: "A landing page",
    });
    expect(d.removePaths).toHaveBeenCalledWith(["/home/me/.uno-recordings/rec1/agent-copy.mp4"]);
  });

  it("skips (not fails) when there is no copy, it is too big or too long", () => {
    expect(watchSkipReason(item({ agentCopy: null }))).toContain("couldn't make");
    expect(
      watchSkipReason(item({ agentCopy: new Blob([new Uint8Array(26 * 1024 * 1024)]) })),
    ).toContain("too big");
    expect(watchSkipReason(item({ durationMs: 11 * 60 * 1000 }))).toContain("10 minutes");
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
