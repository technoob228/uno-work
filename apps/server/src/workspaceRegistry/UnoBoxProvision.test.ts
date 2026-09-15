import { UNO_WORK_GOLDEN_IMAGE_ID, type UnoBoxCreateJobStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  isTerminalUnoBoxCreateJobState,
  runUnoBoxProvisionJob,
  type UnoBoxProvisionClient,
  type UnoBoxProvisionDeps,
} from "./UnoBoxProvision.ts";

const TIMING = {
  statusPollIntervalMs: 10,
  statusPollTimeoutMs: 100,
  pairingRetryIntervalMs: 10,
  pairingTimeoutMs: 100,
};

function rawBox(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    name: "my-app",
    status: "provisioning",
    os: "ubuntu-24.04",
    ram_mb: 2048,
    vcpu: 1,
    disk_gb: 10,
    ssh: null,
    public_ip: null,
    internal_ip: null,
    created_at: "2026-09-09T10:00:00Z",
    sleep_deadline_at: null,
    ...overrides,
  };
}

function makeHarness(clientOverrides: Partial<UnoBoxProvisionClient> = {}) {
  // A fake clock: `sleep` advances it so timeouts are deterministic.
  let clock = 0;
  const statuses: UnoBoxCreateJobStatus[] = [];
  const client: UnoBoxProvisionClient = {
    // A control plane without GET /api/v1/work/image answers a plain-text 404.
    getWorkImage: vi.fn(async () => {
      throw new Error("404: 404 page not found");
    }),
    launchImage: vi.fn(async () => rawBox()),
    createPlainBox: vi.fn(async () => rawBox({ id: 777 })),
    getBox: vi.fn(async () => rawBox({ status: "running" })),
    createWorkSession: vi.fn(async () => ({
      url: "https://box-501.uno4.dev/pair#token=abc",
      hostname: "box-501.uno4.dev",
      expires_at: "2026-09-09T10:05:00Z",
    })),
    ...clientOverrides,
  };
  const deps: UnoBoxProvisionDeps = {
    client,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    onStatus: (status) => statuses.push(status),
    timing: TIMING,
  };
  return { client, deps, statuses, states: () => statuses.map((status) => status.state) };
}

const INPUT = { jobId: "job-1", name: "my-app" };

describe("runUnoBoxProvisionJob", () => {
  it("walks creating → starting → waiting_daemon → ready on the happy path", async () => {
    const harness = makeHarness();
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("ready");
    expect(result.boxId).toBe(501);
    expect(result.box?.name).toBe("my-app");
    expect(result.connection).toEqual({
      boxId: 501,
      url: "https://box-501.uno4.dev/pair#token=abc",
      hostname: "box-501.uno4.dev",
      expiresAt: "2026-09-09T10:05:00Z",
    });
    expect(harness.states()).toEqual([
      "creating",
      "starting",
      "starting",
      "waiting_daemon",
      "ready",
    ]);
    // The terminal status is the last thing the sink saw.
    expect(harness.statuses.at(-1)).toEqual(result);
  });

  it("launches from the golden image exactly once with defaults filled in", async () => {
    const harness = makeHarness();
    await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(harness.client.launchImage).toHaveBeenCalledTimes(1);
    expect(harness.client.launchImage).toHaveBeenCalledWith(UNO_WORK_GOLDEN_IMAGE_ID, {
      name: "my-app",
      ram_mb: 2048,
      vcpu: 1,
      disk_gb: 10,
    });
    expect(harness.client.createPlainBox).not.toHaveBeenCalled();
  });

  it("honours explicit size and image overrides", async () => {
    const harness = makeHarness();
    await runUnoBoxProvisionJob(
      { ...INPUT, ramMb: 4096, vcpu: 2, diskGb: 20, goldenImageId: 99 },
      harness.deps,
    );

    expect(harness.client.launchImage).toHaveBeenCalledWith(99, {
      name: "my-app",
      ram_mb: 4096,
      vcpu: 2,
      disk_gb: 20,
    });
    // An explicit override is not second-guessed by the control plane's choice.
    expect(harness.client.getWorkImage).not.toHaveBeenCalled();
  });

  it("launches the golden image it does not own, from the id the control plane names", async () => {
    // The owner-only image list is never consulted: that lookup is what sent
    // every account except the image owner to a plain box without the daemon.
    const harness = makeHarness({
      getWorkImage: vi.fn(async () => ({
        image_id: 126,
        name: "uno-work-golden-v9",
        state: "ready",
      })),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("ready");
    expect(harness.client.launchImage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.client.launchImage).mock.calls[0]?.[0]).toBe(126);
    expect(harness.client.createPlainBox).not.toHaveBeenCalled();
  });

  it("retries the pairing link while the daemon boots and never re-launches", async () => {
    let attempts = 0;
    const harness = makeHarness({
      createWorkSession: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("500: INTERNAL_ERROR");
        return { url: "https://box-501.uno4.dev/pair#token=late", hostname: "h" };
      }),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("ready");
    expect(result.connection?.url).toContain("token=late");
    expect(harness.client.createWorkSession).toHaveBeenCalledTimes(3);
    expect(harness.client.launchImage).toHaveBeenCalledTimes(1);
  });

  it("fails with the last daemon error when pairing never succeeds", async () => {
    const harness = makeHarness({
      createWorkSession: vi.fn(async () => {
        throw new Error("500: INTERNAL_ERROR");
      }),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("failed");
    expect(result.boxId).toBe(501);
    expect(result.message).toContain("INTERNAL_ERROR");
    expect(result.message).toContain("Connect from the box list");
    expect(harness.client.launchImage).toHaveBeenCalledTimes(1);
  });

  it("polls box status until running and fails after the status timeout", async () => {
    const harness = makeHarness({
      getBox: vi.fn(async () => rawBox({ status: "provisioning" })),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("failed");
    expect(result.message).toContain('did not reach "running"');
    expect(result.boxId).toBe(501);
    expect(harness.client.createWorkSession).not.toHaveBeenCalled();
    // 100ms cap / 10ms interval → bounded number of polls, not a spin.
    expect(vi.mocked(harness.client.getBox).mock.calls.length).toBeLessThanOrEqual(11);
  });

  it("tolerates transient status-read errors while polling", async () => {
    let reads = 0;
    const harness = makeHarness({
      getBox: vi.fn(async () => {
        reads += 1;
        if (reads === 1) throw new Error("502: bad gateway");
        return rawBox({ status: "running" });
      }),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("ready");
  });

  it("fails when the box dies while booting", async () => {
    const harness = makeHarness({
      getBox: vi.fn(async () => rawBox({ status: "error" })),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("failed");
    expect(result.message).toContain('"error"');
  });

  it("fails without creating anything when the launch call is rejected", async () => {
    const harness = makeHarness({
      launchImage: vi.fn(async () => {
        throw new Error("402: insufficient balance");
      }),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("failed");
    expect(result.boxId).toBeUndefined();
    expect(result.message).toContain("402: insufficient balance");
    expect(harness.client.getBox).not.toHaveBeenCalled();
    expect(harness.client.createPlainBox).not.toHaveBeenCalled();
  });

  it("falls back to a plain box only when the launch says the image does not exist", async () => {
    const harness = makeHarness({
      launchImage: vi.fn(async () => {
        throw new Error('404: {"error":"NOT_FOUND"}');
      }),
      getBox: vi.fn(async () => rawBox({ id: 777, status: "running" })),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(harness.client.launchImage).toHaveBeenCalledTimes(1);
    expect(harness.client.createPlainBox).toHaveBeenCalledTimes(1);
    expect(harness.client.createPlainBox).toHaveBeenCalledWith({
      name: "my-app",
      ram_mb: 2048,
      vcpu: 1,
      disk_gb: 10,
      template: "ubuntu-24.04",
      network_profile: "nat",
    });
    expect(result.state).toBe("failed");
    expect(result.daemonInstallRequired).toBe(true);
    expect(result.boxId).toBe(777);
    expect(result.message).toContain("daemon is not installed");
    expect(harness.client.createWorkSession).not.toHaveBeenCalled();
  });

  it("uses the built-in image id when the control plane cannot name one", async () => {
    const harness = makeHarness({
      getWorkImage: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("ready");
    expect(vi.mocked(harness.client.launchImage).mock.calls[0]?.[0]).toBe(UNO_WORK_GOLDEN_IMAGE_ID);
    expect(harness.client.createPlainBox).not.toHaveBeenCalled();
  });

  it("refuses to create anything when the golden image is in a dead state", async () => {
    const harness = makeHarness({
      getWorkImage: vi.fn(async () => ({ image_id: 126, name: "golden", state: "error" })),
    });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("failed");
    expect(result.message).toContain("Nothing was created");
    expect(harness.client.launchImage).not.toHaveBeenCalled();
    expect(harness.client.createPlainBox).not.toHaveBeenCalled();
  });

  it("fails when the launch answer is not a box", async () => {
    const harness = makeHarness({ launchImage: vi.fn(async () => ({ ok: true })) });
    const result = await runUnoBoxProvisionJob(INPUT, harness.deps);

    expect(result.state).toBe("failed");
    expect(result.message).toContain("did not return a box");
  });
});

describe("isTerminalUnoBoxCreateJobState", () => {
  it("treats only ready and failed as terminal", () => {
    expect(isTerminalUnoBoxCreateJobState("creating")).toBe(false);
    expect(isTerminalUnoBoxCreateJobState("starting")).toBe(false);
    expect(isTerminalUnoBoxCreateJobState("waiting_daemon")).toBe(false);
    expect(isTerminalUnoBoxCreateJobState("ready")).toBe(true);
    expect(isTerminalUnoBoxCreateJobState("failed")).toBe(true);
  });
});
