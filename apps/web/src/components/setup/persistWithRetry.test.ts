import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { persistWithRetry } from "./persistWithRetry";

describe("persistWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a write lost in a fresh computer's first seconds still lands on a repeat (walk 29.10)", async () => {
    const landed: string[] = [];
    let attempt = 0;
    const write = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("socket closed: session key rotated");
      landed.push("own_agent_sign_in_prompted");
    });

    await persistWithRetry(write, "[agent-sign-in]");
    expect(landed).toEqual([]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(landed).toEqual(["own_agent_sign_in_prompted"]);
  });

  it("is always sent, then repeated three times (idempotent writes)", async () => {
    const write = vi.fn(async () => undefined);
    await persistWithRetry(write);
    expect(write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(write).toHaveBeenCalledTimes(4);
  });

  it("doesn't hold the caller longer than 6 s on a write that never answers", async () => {
    const write = vi.fn(() => new Promise<void>(() => undefined));
    let done = false;
    void persistWithRetry(write).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(5_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });
});
