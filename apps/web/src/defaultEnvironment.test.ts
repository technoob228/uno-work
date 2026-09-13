import { describe, expect, it } from "vitest";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  resolveDefaultEnvironment,
  shouldOfferDefaultEnvironmentChoice,
  type DefaultEnvironmentCandidate,
} from "./defaultEnvironment";

const id = (value: string) => value as EnvironmentId;

function candidate(
  environmentId: string,
  overrides: Partial<Omit<DefaultEnvironmentCandidate, "environmentId">> = {},
): DefaultEnvironmentCandidate {
  return {
    environmentId: id(environmentId),
    kind: "server",
    online: true,
    isPrimary: false,
    ...overrides,
  };
}

describe("resolveDefaultEnvironment", () => {
  it("honours the explicit choice while it is known and reachable", () => {
    expect(
      resolveDefaultEnvironment({
        explicitDefaultId: id("box"),
        candidates: [
          candidate("laptop", { kind: "computer" }),
          candidate("box", { kind: "uno_box", isPrimary: true }),
        ],
      }),
    ).toBe("box");
  });

  it("skips an explicit choice that is offline or no longer known", () => {
    const candidates = [
      candidate("laptop", { kind: "computer" }),
      candidate("box", { kind: "uno_box", online: false, isPrimary: true }),
    ];
    expect(resolveDefaultEnvironment({ explicitDefaultId: id("box"), candidates })).toBe("laptop");
    expect(resolveDefaultEnvironment({ explicitDefaultId: id("gone"), candidates })).toBe("laptop");
  });

  it("prefers an online computer of the user's over the primary daemon", () => {
    expect(
      resolveDefaultEnvironment({
        explicitDefaultId: null,
        candidates: [
          candidate("box", { kind: "uno_box", isPrimary: true }),
          candidate("laptop", { kind: "computer" }),
        ],
      }),
    ).toBe("laptop");
  });

  it("falls back to the primary daemon, then to nothing", () => {
    expect(
      resolveDefaultEnvironment({
        explicitDefaultId: null,
        candidates: [
          candidate("laptop", { kind: "computer", online: false }),
          candidate("box", { kind: "uno_box", isPrimary: true }),
          candidate("vps"),
        ],
      }),
    ).toBe("box");
    expect(resolveDefaultEnvironment({ explicitDefaultId: null, candidates: [] })).toBeNull();
    expect(
      resolveDefaultEnvironment({
        explicitDefaultId: null,
        candidates: [candidate("vps", { online: false })],
      }),
    ).toBeNull();
  });
});

describe("shouldOfferDefaultEnvironmentChoice", () => {
  it("asks only with two or more machines and no valid explicit choice", () => {
    const two = [candidate("a", { isPrimary: true }), candidate("b")];
    expect(shouldOfferDefaultEnvironmentChoice({ explicitDefaultId: null, candidates: two })).toBe(
      true,
    );
    expect(
      shouldOfferDefaultEnvironmentChoice({ explicitDefaultId: id("a"), candidates: two }),
    ).toBe(false);
    expect(
      shouldOfferDefaultEnvironmentChoice({ explicitDefaultId: id("gone"), candidates: two }),
    ).toBe(true);
    expect(
      shouldOfferDefaultEnvironmentChoice({ explicitDefaultId: null, candidates: [two[0]!] }),
    ).toBe(false);
  });
});
