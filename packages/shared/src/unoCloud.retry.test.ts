import { describe, expect, it } from "vitest";

import {
  ControlPlaneHttpError,
  WORK_MACHINE_STARTING_RETRY_MS,
  WORK_MACHINE_STILL_STARTING_MESSAGE,
  isWorkMachineStartingError,
  retryWhileWorkMachineStarts,
} from "./unoCloud.ts";

const starting = () =>
  new ControlPlaneHttpError(
    409,
    '409: {"error":"WORK_MACHINE_STARTING: the machine is still starting — retry shortly"}',
  );

function clock() {
  let at = 0;
  const waits: number[] = [];
  return {
    waits,
    deps: {
      now: () => at,
      sleep: async (ms: number) => {
        waits.push(ms);
        at += ms;
      },
    },
  };
}

describe("retryWhileWorkMachineStarts", () => {
  it("waits and asks again while the console says the computer is starting", async () => {
    const { waits, deps } = clock();
    let calls = 0;
    const result = await retryWhileWorkMachineStarts(async () => {
      calls += 1;
      if (calls < 3) throw starting();
      return "link";
    }, deps);
    expect(result).toBe("link");
    expect(calls).toBe(3);
    expect(waits).toEqual([WORK_MACHINE_STARTING_RETRY_MS, WORK_MACHINE_STARTING_RETRY_MS]);
  });

  it("passes any other failure on at once", async () => {
    const { waits, deps } = clock();
    const refused = new ControlPlaneHttpError(402, "402: PLAN_REQUIRED");
    await expect(
      retryWhileWorkMachineStarts(async () => {
        throw refused;
      }, deps),
    ).rejects.toBe(refused);
    expect(waits).toEqual([]);
    expect(isWorkMachineStartingError(refused)).toBe(false);
  });

  it("gives up after a minute with plain words", async () => {
    const { waits, deps } = clock();
    await expect(
      retryWhileWorkMachineStarts(async () => {
        throw starting();
      }, deps),
    ).rejects.toThrow(WORK_MACHINE_STILL_STARTING_MESSAGE);
    expect(waits.length).toBe(20);
  });
});
