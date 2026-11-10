import { describe, expect, it } from "vitest";

import { pickAccountUno, pickHomeEnvironmentId, unoMoveClaims } from "./accountUno";

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

describe("where Uno moved (10.11)", () => {
  const rows = [
    { kind: "local", environmentId: "mac", status: "online", isPrimary: true },
    { kind: "uno_box", environmentId: "kinship", status: "online", isPrimary: false },
    { kind: "uno_box", environmentId: "stage", status: "online", isPrimary: false },
  ] as never;

  it("the computer Uno moved to last wins over the first cloud computer", () => {
    const claims = unoMoveClaims([
      {
        environmentId: "kinship",
        assistants: [uno({ movedTo: { boxId: 2531, name: "stage", at: "t1" } })],
      },
      { environmentId: "stage", assistants: [uno({ movedInAt: "2026-11-10T21:00:00Z" })] },
    ]);
    expect(pickHomeEnvironmentId(rows, claims)).toBe("stage");
  });

  it("without a claim the app skips a computer Uno left", () => {
    const claims = unoMoveClaims([
      {
        environmentId: "kinship",
        assistants: [uno({ movedTo: { boxId: 1, name: "x", at: "t" } })],
      },
    ]);
    expect(pickHomeEnvironmentId(rows, claims)).toBe("stage");
    expect(pickHomeEnvironmentId(rows)).toBe("kinship");
  });
});

function uno(move: Record<string, unknown>) {
  return { projectId: "assistant-home", move } as never;
}

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
