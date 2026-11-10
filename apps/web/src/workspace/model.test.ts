import { describe, expect, it } from "vitest";

import {
  appReadiness,
  assistantReach,
  hardwareSummary,
  nextTurnPlace,
  usedBy,
  type Workspace,
  type WsComputer,
} from "./model";

const computer = (id: string, patch: Partial<WsComputer> = {}): WsComputer => ({
  id,
  name: id,
  kind: "cloud",
  state: "running",
  detail: "",
  place: "",
  environmentId: null,
  ...patch,
});

const ws = (computers: ReadonlyArray<WsComputer>): Workspace => ({
  id: "w",
  name: "Misha",
  cloud: { region: "EU" },
  computers,
  parts: [
    { id: "db", kind: "database", name: "orders", detail: "Postgres", on: "work" },
    { id: "fn", kind: "spark", name: "hook", detail: "JS", on: null },
  ],
  apps: [
    { id: "orders", name: "Orders", icon: "", url: "", uses: [{ ref: "db", role: "stores" }] },
    { id: "landing", name: "Landing", icon: "", url: "", uses: [{ ref: "fn", role: "calls" }] },
    { id: "deck", name: "Deck", icon: "", url: "", uses: [{ ref: "mac", role: "runs" }] },
  ],
  assistants: [
    { id: "uno", name: "Uno", hands: ["work", "mac", "free"], wakes: true, telegram: true },
  ],
});

describe("appReadiness", () => {
  it("opens at once when what it uses is up, or lives only in the cloud", () => {
    const space = ws([computer("work"), computer("mac", { kind: "local" })]);
    expect(appReadiness(space, space.apps[0]!).kind).toBe("ready");
    expect(appReadiness(space, space.apps[1]!).kind).toBe("ready");
  });

  it("wakes a sleeping cloud computer that its database lives on", () => {
    const space = ws([computer("work", { state: "asleep" })]);
    const ready = appReadiness(space, space.apps[0]!);
    expect(ready).toMatchObject({ kind: "wakes", computer: { id: "work" } });
  });

  it("says plainly when a laptop it runs on is away — nobody can wake it from here", () => {
    const space = ws([computer("work"), computer("mac", { kind: "local", state: "asleep" })]);
    expect(appReadiness(space, space.apps[2]!)).toMatchObject({
      kind: "unavailable",
      computer: { id: "mac" },
    });
  });

  it("an app whose computer was removed opens on what's left", () => {
    const space = ws([computer("work")]);
    expect(appReadiness(space, space.apps[2]!).kind).toBe("ready");
  });
});

describe("usedBy", () => {
  it("counts apps through the parts that live on a computer", () => {
    const space = ws([computer("work"), computer("mac", { kind: "local" })]);
    expect(usedBy(space, "work").apps.map((app) => app.id)).toEqual(["orders"]);
    expect(usedBy(space, "mac").assistants.map((a) => a.id)).toEqual(["uno"]);
  });
});

describe("assistantReach", () => {
  it("splits its hands into up, wakeable and away", () => {
    const space = ws([
      computer("work"),
      computer("mac", { kind: "local", state: "offline" }),
      computer("free", { state: "asleep" }),
    ]);
    const reach = assistantReach(space, space.assistants[0]!);
    expect(reach.up.map((c) => c.id)).toEqual(["work"]);
    expect(reach.wakeable.map((c) => c.id)).toEqual(["free"]);
    expect(reach.away.map((c) => c.id)).toEqual(["mac"]);
  });

  it("without waking, a sleeping cloud computer is away too", () => {
    const space = ws([computer("work", { state: "asleep" })]);
    const reach = assistantReach(space, { ...space.assistants[0]!, hands: ["work"], wakes: false });
    expect(reach.wakeable).toEqual([]);
    expect(reach.away.map((c) => c.id)).toEqual(["work"]);
  });
});

describe("nextTurnPlace", () => {
  const space = ws([
    computer("work"),
    computer("free", { state: "asleep" }),
    computer("mac", { kind: "local", state: "offline" }),
  ]);
  it("the chat's own computer when nothing is picked", () => {
    expect(nextTurnPlace(space, null, "work")).toMatchObject({
      computer: { id: "work" },
      note: null,
    });
  });
  it("a sleeping cloud computer wakes on send", () => {
    expect(nextTurnPlace(space, "free", "work").note).toBe("wakes when you send");
  });
  it("an offline laptop is named as such", () => {
    expect(nextTurnPlace(space, "mac", "work").note).toBe("offline");
  });
  it("a removed pick falls back to the chat's own", () => {
    expect(nextTurnPlace(space, "gone", "work").computer?.id).toBe("work");
  });
});

describe("hardwareSummary", () => {
  it("counts computers by state and every part", () => {
    const space = ws([
      computer("work"),
      computer("free", { state: "asleep" }),
      computer("mac", { kind: "local", state: "offline" }),
    ]);
    expect(hardwareSummary(space)).toEqual({ up: 1, asleep: 1, offline: 1, parts: 2 });
  });
});
