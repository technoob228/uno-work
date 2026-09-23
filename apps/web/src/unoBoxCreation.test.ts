import type { UnoBoxCreateJobStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  UNO_BOX_SIZE_PRESETS,
  describeUnoBoxCreateJobState,
  normalizeUnoBoxName,
  waitForUnoBoxCreateJob,
} from "./unoBoxCreation";

function status(
  state: UnoBoxCreateJobStatus["state"],
  extra: Partial<UnoBoxCreateJobStatus> = {},
): UnoBoxCreateJobStatus {
  return { jobId: "job-1", state, ...extra };
}

function makeClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
  };
}

describe("waitForUnoBoxCreateJob", () => {
  it("polls until the job is ready and reports each status on the way", async () => {
    const sequence = [status("creating"), status("starting"), status("waiting_daemon")];
    const ready = status("ready", {
      boxId: 5,
      connection: { boxId: 5, url: "https://h/pair#t", hostname: "h", expiresAt: null },
    });
    const getStatus = vi.fn(async () => sequence.shift() ?? ready);
    const seen: string[] = [];
    const clock = makeClock();

    const result = await waitForUnoBoxCreateJob(getStatus, "job-1", {
      ...clock,
      intervalMs: 10,
      onStatus: (next) => seen.push(next.state),
    });

    expect(result).toEqual(ready);
    expect(seen).toEqual(["creating", "starting", "waiting_daemon", "ready"]);
    expect(getStatus).toHaveBeenCalledTimes(4);
    expect(getStatus).toHaveBeenCalledWith("job-1");
  });

  it("returns a failed status instead of throwing so the caller can show the message", async () => {
    const failed = status("failed", { message: "402: insufficient balance" });
    const result = await waitForUnoBoxCreateJob(async () => failed, "job-1", makeClock());
    expect(result).toEqual(failed);
  });

  it("tolerates a few status-read errors, then gives up", async () => {
    let calls = 0;
    const getStatus = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("socket closed");
      return status("ready");
    });
    const result = await waitForUnoBoxCreateJob(getStatus, "job-1", {
      ...makeClock(),
      intervalMs: 1,
      maxConsecutiveErrors: 3,
    });
    expect(result.state).toBe("ready");

    const alwaysFails = vi.fn(async () => {
      throw new Error("socket closed");
    });
    await expect(
      waitForUnoBoxCreateJob(alwaysFails, "job-1", {
        ...makeClock(),
        intervalMs: 1,
        maxConsecutiveErrors: 3,
      }),
    ).rejects.toThrow(/Lost track of creating the computer/);
    expect(alwaysFails).toHaveBeenCalledTimes(3);
  });

  it("stops after the client-side timeout when the job never finishes", async () => {
    const getStatus = vi.fn(async () => status("starting"));
    await expect(
      waitForUnoBoxCreateJob(getStatus, "job-1", {
        ...makeClock(),
        intervalMs: 10,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/taking longer than expected/);
    expect(getStatus.mock.calls.length).toBeLessThanOrEqual(7);
  });
});

describe("normalizeUnoBoxName", () => {
  it("slugs arbitrary project titles into a hostname-safe name", () => {
    expect(normalizeUnoBoxName("My App (v2)")).toBe("my-app-v2");
    expect(normalizeUnoBoxName("  uno_work  ")).toBe("uno-work");
    expect(normalizeUnoBoxName("---")).toBe("");
    expect(normalizeUnoBoxName("a".repeat(60))).toHaveLength(40);
    expect(normalizeUnoBoxName(`${"a".repeat(39)}-b`)).toBe("a".repeat(39));
  });
});

describe("presets and labels", () => {
  it("offers only sizes the Work image can boot (4 GB and up)", () => {
    expect(Object.keys(UNO_BOX_SIZE_PRESETS)).toEqual(["medium"]);
    expect(UNO_BOX_SIZE_PRESETS.medium).toMatchObject({ ramMb: 4096, vcpu: 2, diskGb: 20 });
    for (const spec of Object.values(UNO_BOX_SIZE_PRESETS)) {
      expect(spec.ramMb).toBeGreaterThanOrEqual(4096);
    }
  });

  it("has a label for every job state", () => {
    for (const state of ["creating", "starting", "waiting_daemon", "ready", "failed"] as const) {
      expect(describeUnoBoxCreateJobState(state).length).toBeGreaterThan(0);
    }
  });
});
