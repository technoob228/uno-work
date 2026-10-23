import { afterEach, describe, expect, it, vi } from "vitest";

import { BWRAP_PROBE_ARGS } from "./harnessSandbox.ts";
import {
  assistantSandboxCapability,
  probeAssistantSandbox,
  resetAssistantSandboxCapabilityCache,
  type SandboxProbeDeps,
} from "./sandboxCapability.ts";

const deps = (overrides: Partial<SandboxProbeDeps> = {}): SandboxProbeDeps => ({
  platform: "linux",
  findBwrap: () => "/usr/bin/bwrap",
  run: async () => 0,
  ...overrides,
});

afterEach(() => resetAssistantSandboxCapabilityCache());

describe("probeAssistantSandbox", () => {
  it("is available on Linux when bwrap starts a sandbox with the real namespaces", async () => {
    const run = vi.fn(async () => 0);
    await expect(probeAssistantSandbox(deps({ run }))).resolves.toEqual({
      available: true,
      bwrapPath: "/usr/bin/bwrap",
      reason: null,
    });
    expect(run).toHaveBeenCalledWith("/usr/bin/bwrap", BWRAP_PROBE_ARGS);
    expect(BWRAP_PROBE_ARGS).toEqual(expect.arrayContaining(["--unshare-user", "--unshare-pid"]));
  });

  it("is not available on a Mac (no probe at all)", async () => {
    const run = vi.fn(async () => 0);
    const result = await probeAssistantSandbox(deps({ platform: "darwin", run }));
    expect(result.available).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("is not available without bwrap", async () => {
    const result = await probeAssistantSandbox(deps({ findBwrap: () => null }));
    expect(result).toMatchObject({ available: false, bwrapPath: null });
  });

  it("is not available when bwrap fails (user namespaces off) or hangs", async () => {
    expect((await probeAssistantSandbox(deps({ run: async () => 1 }))).available).toBe(false);
    expect((await probeAssistantSandbox(deps({ run: async () => null }))).available).toBe(false);
  });
});

describe("assistantSandboxCapability (cached)", () => {
  it("probes once while it works", async () => {
    const run = vi.fn(async () => 0);
    await assistantSandboxCapability(0, deps({ run }));
    await assistantSandboxCapability(10 * 60_000, deps({ run }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("probes again a minute after a failure", async () => {
    const run = vi.fn(async () => 1);
    expect((await assistantSandboxCapability(0, deps({ run }))).available).toBe(false);
    expect((await assistantSandboxCapability(30_000, deps({ run }))).available).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    run.mockImplementation(async () => 0);
    expect((await assistantSandboxCapability(61_000, deps({ run }))).available).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
