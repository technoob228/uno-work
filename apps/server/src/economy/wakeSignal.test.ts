import { describe, expect, it } from "vitest";

import { longPollSignal, signalMachineWoke } from "./wakeSignal.ts";

describe("wake signal", () => {
  it("aborts in-flight long-polls on wake, not later ones", () => {
    const before = longPollSignal(60_000);
    expect(before.aborted).toBe(false);
    signalMachineWoke();
    expect(before.aborted).toBe(true);
    const after = longPollSignal(60_000);
    expect(after.aborted).toBe(false);
  });
});
