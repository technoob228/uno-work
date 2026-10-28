import { describe, expect, it } from "vitest";

import { pickAccountUno, pickHomeEnvironmentId } from "./accountUno";

describe("the account's home computer", () => {
  it("is the cloud computer when it is up", () => {
    expect(
      pickHomeEnvironmentId([
        { kind: "local", environmentId: "mac" as never, status: "online", isPrimary: true },
        { kind: "uno_box", environmentId: "box" as never, status: "online", isPrimary: false },
      ] as never),
    ).toBe("box");
  });

  it("else the computer serving the app", () => {
    expect(
      pickHomeEnvironmentId([
        { kind: "local", environmentId: "mac" as never, status: "online", isPrimary: true },
        { kind: "uno_box", environmentId: "box" as never, status: "offline", isPrimary: false },
      ] as never),
    ).toBe("mac");
    expect(pickHomeEnvironmentId([])).toBeNull();
  });
});

describe("one Uno per account", () => {
  const unos = [
    { environmentId: "mac", talked: 50 },
    { environmentId: "box", talked: 10 },
  ];
  const lastTalkMs = (uno: { talked: number }) => uno.talked;

  it("the home computer's Uno, even if the person talked to another one later", () => {
    expect(pickAccountUno(unos, { homeEnvironmentId: "box", lastTalkMs })?.environmentId).toBe(
      "box",
    );
  });

  it("home not connected: the one talked to last", () => {
    expect(pickAccountUno(unos, { homeEnvironmentId: "gone", lastTalkMs })?.environmentId).toBe(
      "mac",
    );
    expect(pickAccountUno([], { homeEnvironmentId: null, lastTalkMs })).toBeUndefined();
  });
});
