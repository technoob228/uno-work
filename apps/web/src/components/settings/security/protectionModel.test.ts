import { describe, expect, it } from "vitest";

import {
  type Protection,
  effectiveMode,
  needsPrivateNetwork,
  overrides,
  plural,
  stoppable,
} from "./protectionModel";

function protection(patch: Partial<Protection["isolation"]> = {}, setUp = false): Protection {
  return {
    isolation: {
      all: "open",
      computers: [
        { id: 1, name: "a", status: "running", mode: "inherit" },
        { id: 2, name: "b", status: "sleeping", mode: "inherit" },
        { id: 3, name: "c", status: "stopped", mode: "inherit" },
      ],
      uno_ai_when_isolated: true,
      limited_allow: [],
      ...patch,
    },
    private_network: { set_up: setUp, devices: [] },
    emergency: null,
  };
}

describe("protectionModel", () => {
  it("a computer follows all computers unless it has its own mode", () => {
    expect(effectiveMode("limited", "inherit")).toBe("limited");
    expect(effectiveMode("limited", "open")).toBe("open");
  });

  it("asks for the private network only when something is isolated and no device is in it", () => {
    expect(needsPrivateNetwork(protection())).toBe(false);
    expect(needsPrivateNetwork(protection({ all: "isolated" }))).toBe(true);
    expect(needsPrivateNetwork(protection({ all: "isolated" }, true))).toBe(false);
    const one = protection();
    expect(
      needsPrivateNetwork({
        ...one,
        isolation: {
          ...one.isolation,
          computers: [{ id: 1, name: "a", status: "running", mode: "isolated" }],
        },
      }),
    ).toBe(true);
  });

  it("the red button stops running and sleeping computers, not stopped ones", () => {
    expect(stoppable(protection().isolation.computers).map((c) => c.id)).toEqual([1, 2]);
  });

  it("lists computers that differ from all", () => {
    const p = protection();
    expect(overrides(p)).toEqual([]);
  });

  it("counts in plain words", () => {
    expect(plural(1, "computer")).toBe("1 computer");
    expect(plural(3, "computer")).toBe("3 computers");
  });
});
