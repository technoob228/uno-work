import type { UnoBox, UnoCloudState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import type { SavedEnvironmentRecord } from "./environments/runtime";
import {
  connectUnoBoxWith,
  isUnoBoxStillStartingError,
  UnoBoxConnectAbortedError,
  type UnoBoxConnectDeps,
  type UnoBoxConnectProgress,
} from "./unoBoxConnect";

vi.mock("./environmentApi", () => ({ ensureEnvironmentApi: vi.fn() }));
vi.mock("./environments/runtime", () => ({ addSavedEnvironment: vi.fn() }));

function box(status: string): UnoBox {
  return {
    id: 7,
    name: "e2e-new",
    status,
    os: "",
    ramMb: 2048,
    vcpu: 1,
    diskGb: 10,
    ssh: null,
    publicIp: null,
    internalIp: null,
    createdAt: null,
    sleepDeadlineAt: null,
  };
}

function state(status: string): UnoCloudState {
  return { connected: true, account: null, boxes: [box(status)], fetchedAt: "", error: null };
}

const RECORD = { environmentId: "env-7", label: "e2e-new" } as unknown as SavedEnvironmentRecord;

function harness(overrides: Partial<UnoBoxConnectDeps> = {}) {
  let clock = 0;
  const deps: UnoBoxConnectDeps = {
    getState: vi.fn(async () => state("running")),
    boxPower: vi.fn(async () => state("starting")),
    mintConnection: vi.fn(async () => ({
      boxId: 7,
      url: "https://b7.app.uno4.dev/pair#token=t",
      hostname: "b7.app.uno4.dev",
      expiresAt: null,
    })),
    pair: vi.fn(async () => RECORD),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...overrides,
  };
  return deps;
}

describe("connectUnoBoxWith", () => {
  it("connects a running box with the box name and id", async () => {
    const deps = harness();
    await expect(connectUnoBoxWith(deps, box("running"))).resolves.toBe(RECORD);
    expect(deps.boxPower).not.toHaveBeenCalled();
    expect(deps.pair).toHaveBeenCalledWith({
      label: "e2e-new",
      pairingUrl: "https://b7.app.uno4.dev/pair#token=t",
      unoBoxId: 7,
    });
  });

  it("wakes a sleeping box and waits for running before pairing", async () => {
    const phases: UnoBoxConnectProgress["phase"][] = [];
    let reads = 0;
    const deps = harness({
      getState: vi.fn(async () => {
        reads += 1;
        return state(reads >= 2 ? "running" : "starting");
      }),
    });
    await connectUnoBoxWith(deps, box("sleeping"), {
      onProgress: (progress) => phases.push(progress.phase),
    });
    expect(deps.boxPower).toHaveBeenCalledWith(7, "wake");
    expect(phases[0]).toBe("waking");
    expect(phases).toContain("connecting");
    expect(deps.pair).toHaveBeenCalledTimes(1);
  });

  it("starts (not wakes) a stopped box", async () => {
    const deps = harness({ boxPower: vi.fn(async () => state("running")) });
    await connectUnoBoxWith(deps, box("stopped"));
    expect(deps.boxPower).toHaveBeenCalledWith(7, "start");
  });

  it("retries 'Failed to fetch' with a fresh link each time", async () => {
    let attempts = 0;
    const deps = harness({
      pair: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw new TypeError("Failed to fetch");
        return RECORD;
      }),
    });
    await expect(connectUnoBoxWith(deps, box("running"))).resolves.toBe(RECORD);
    expect(deps.mintConnection).toHaveBeenCalledTimes(3);
  });

  it("uses the job's link for the first attempt only", async () => {
    let attempts = 0;
    const deps = harness({
      pair: vi.fn(async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("502: bad gateway");
        return RECORD;
      }),
    });
    await connectUnoBoxWith(deps, box("running"), {
      initialConnection: {
        boxId: 7,
        url: "https://x/pair#token=job",
        hostname: "x",
        expiresAt: null,
      },
    });
    expect(deps.mintConnection).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.pair).mock.calls[0]?.[0].pairingUrl).toContain("token=job");
  });

  it("gives up with 'still starting' (not a failure) past the budget", async () => {
    const deps = harness({
      pair: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    const caught = await connectUnoBoxWith(deps, box("running"), { budgetMs: 20_000 }).catch(
      (error: unknown) => error,
    );
    expect(isUnoBoxStillStartingError(caught)).toBe(true);
  });

  it("does not retry a broken box", async () => {
    const deps = harness({
      mintConnection: vi.fn(async () => {
        throw new Error('409: {"error":"box entered status \\"error\\""}');
      }),
    });
    await expect(connectUnoBoxWith(deps, box("running"))).rejects.toThrow("409");
    expect(deps.mintConnection).toHaveBeenCalledTimes(1);
  });

  it("refuses a box already in error without calling anything", async () => {
    const deps = harness();
    await expect(connectUnoBoxWith(deps, box("error"))).rejects.toThrow('status "error"');
    expect(deps.mintConnection).not.toHaveBeenCalled();
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      connectUnoBoxWith(harness(), box("running"), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(UnoBoxConnectAbortedError);
  });
});
