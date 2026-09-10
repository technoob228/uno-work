import { describe, expect, it } from "vitest";

import { SetupJobStore } from "./harnessJobs.ts";

const makeStore = (options: { now?: () => number; ttl?: number; cap?: number } = {}) => {
  let counter = 0;
  return new SetupJobStore<{ readonly note: string }>({
    now: options.now ?? (() => 1_000),
    makeJobId: () => `job-${(counter += 1)}`,
    ...(options.ttl !== undefined ? { settledTtlMs: options.ttl } : {}),
    ...(options.cap !== undefined ? { logCapBytes: options.cap } : {}),
  });
};

describe("SetupJobStore", () => {
  it("starts queued, moves to running, then settles", () => {
    const store = makeStore();
    const started = store.start({ kind: "install", driver: "codex", extra: { note: "" } });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.job.state).toBe("queued");
    expect(store.markRunning(started.job.jobId)?.state).toBe("running");
    expect(store.finish(started.job.jobId, { state: "succeeded" })?.state).toBe("succeeded");
    expect(store.get(started.job.jobId)?.error).toBeUndefined();
  });

  it("rejects a second active job for the same kind + driver, but not other drivers or kinds", () => {
    const store = makeStore();
    const first = store.start({ kind: "install", driver: "codex", extra: { note: "" } });
    expect(first.ok).toBe(true);
    const duplicate = store.start({ kind: "install", driver: "codex", extra: { note: "" } });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok && first.ok) expect(duplicate.conflict.jobId).toBe(first.job.jobId);
    expect(store.start({ kind: "install", driver: "hermes", extra: { note: "" } }).ok).toBe(true);
    expect(store.start({ kind: "auth", driver: "codex", extra: { note: "" } }).ok).toBe(true);
  });

  it("allows a new job once the previous one settled", () => {
    const store = makeStore();
    const first = store.start({ kind: "auth", driver: "codex", extra: { note: "" } });
    if (!first.ok) throw new Error("expected start");
    store.finish(first.job.jobId, { state: "failed", error: "nope" });
    expect(store.get(first.job.jobId)?.error).toBe("nope");
    expect(store.start({ kind: "auth", driver: "codex", extra: { note: "" } }).ok).toBe(true);
  });

  it("ignores transitions after a job settled", () => {
    const store = makeStore();
    const started = store.start({ kind: "install", driver: "codex", extra: { note: "" } });
    if (!started.ok) throw new Error("expected start");
    store.finish(started.job.jobId, { state: "succeeded" });
    expect(store.finish(started.job.jobId, { state: "failed", error: "late" })?.state).toBe(
      "succeeded",
    );
    expect(store.markRunning(started.job.jobId)?.state).toBe("succeeded");
    expect(store.appendLog(started.job.jobId, "late output")?.log).toBe("");
  });

  it("scrubs the job secret from log chunks and the failure reason", () => {
    const store = makeStore();
    const started = store.start({
      kind: "auth",
      driver: "codex",
      extra: { note: "" },
      secret: "sk-live-verysecret",
    });
    if (!started.ok) throw new Error("expected start");
    store.markRunning(started.job.jobId);
    store.appendLog(started.job.jobId, "using sk-live-verysecret\n");
    store.finish(started.job.jobId, { state: "failed", error: "rejected sk-live-verysecret" });
    const job = store.get(started.job.jobId);
    expect(job?.log).toBe("using [redacted]\n");
    expect(job?.error).toBe("rejected [redacted]");
  });

  it("caps the log", () => {
    const store = makeStore({ cap: 32 });
    const started = store.start({ kind: "install", driver: "codex", extra: { note: "" } });
    if (!started.ok) throw new Error("expected start");
    store.markRunning(started.job.jobId);
    for (let index = 0; index < 20; index += 1) {
      store.appendLog(started.job.jobId, `line ${index}\n`);
    }
    const log = store.get(started.job.jobId)?.log ?? "";
    expect(log.length).toBeLessThanOrEqual(32);
    expect(log).toContain("line 19");
  });

  it("merges extra patches", () => {
    const store = makeStore();
    const started = store.start({ kind: "auth", driver: "codex", extra: { note: "" } });
    if (!started.ok) throw new Error("expected start");
    expect(store.updateExtra(started.job.jobId, { note: "url" })?.extra.note).toBe("url");
  });

  it("prunes settled jobs after the ttl but keeps active ones", () => {
    let now = 1_000;
    const store = makeStore({ now: () => now, ttl: 100 });
    const settled = store.start({ kind: "install", driver: "codex", extra: { note: "" } });
    const active = store.start({ kind: "install", driver: "hermes", extra: { note: "" } });
    if (!settled.ok || !active.ok) throw new Error("expected start");
    store.finish(settled.job.jobId, { state: "succeeded" });
    now = 1_050;
    expect(store.prune()).toBe(0);
    now = 1_200;
    expect(store.prune()).toBe(1);
    expect(store.get(settled.job.jobId)).toBeUndefined();
    expect(store.get(active.job.jobId)?.state).toBe("queued");
  });
});
