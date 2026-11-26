import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  HAND_TO_COPY,
  canHandle,
  handToComputers,
  handToOptionKey,
  handToOptions,
  remoteHandToOptions,
  type HandToComputer,
  type HandToThreadView,
} from "./handTo.logic";

const id = (value: string) => value as ThreadId;
const chat = (
  value: string,
  extra: Partial<Omit<HandToThreadView, "id">> = {},
): HandToThreadView => ({
  id: id(value),
  title: value,
  createdAt: "2026-11-24T10:00:00.000Z",
  archivedAt: null,
  ...extra,
});

describe("Hand to… picker (T63)", () => {
  it("never offers the chat itself, a chat it started, an archived chat or a loop", () => {
    const threads = [
      chat("a"),
      chat("worker", { spawnedByThreadId: id("a") }),
      chat("old", { archivedAt: "2026-11-20T00:00:00.000Z" }),
      chat("b", { handler: { threadId: id("a") } }),
      chat("c"),
    ];
    const ok = (candidate: string) =>
      canHandle(threads, id("a"), threads.find((thread) => thread.id === candidate)!);
    expect(ok("a")).toBe(false);
    expect(ok("worker")).toBe(false);
    expect(ok("old")).toBe(false);
    expect(ok("b")).toBe(false);
    expect(ok("c")).toBe(true);
  });

  it("keeps chains at most three deep", () => {
    // x → y → z and u → v already: handing v to x would make u → v → x → y → z (4 hops).
    const threads = [
      chat("x", { handler: { threadId: id("y") } }),
      chat("y", { handler: { threadId: id("z") } }),
      chat("z"),
      chat("v"),
      chat("u", { handler: { threadId: id("v") } }),
    ];
    const pick = (name: string) => threads.find((thread) => thread.id === name)!;
    expect(canHandle(threads, id("v"), pick("x"))).toBe(false);
    expect(canHandle(threads, id("v"), pick("y"))).toBe(true);
  });

  it("puts coordinators first, then assistants, then the two latest other chats", () => {
    const threads = [
      chat("me"),
      chat("Launch week", { updatedAt: "2026-11-24T09:00:00.000Z" }),
      chat("h1", { spawnedByThreadId: id("Launch week") }),
      chat("h2", { spawnedByThreadId: id("Launch week") }),
      chat("Uno", { assistantRole: "chat" }),
      chat("Pricing", { updatedAt: "2026-11-24T12:00:00.000Z" }),
      chat("Hero", { updatedAt: "2026-11-24T11:00:00.000Z" }),
      chat("Old one", { updatedAt: "2026-11-01T11:00:00.000Z" }),
    ];
    const options = handToOptions({ threads, threadId: id("me"), query: "" });
    expect(options.coordinators.map((option) => [option.title, option.detail])).toEqual([
      ["Launch week", "Coordinator · runs 2 chats"],
    ]);
    expect(options.assistants.map((option) => [option.title, option.kind])).toEqual([
      ["Uno", "assistant"],
    ]);
    expect(options.others.map((option) => option.title)).toEqual(["Pricing", "Hero"]);
    const found = handToOptions({ threads, threadId: id("me"), query: "old" });
    expect(found.others.map((option) => option.title)).toEqual(["Old one"]);
  });
});

describe("Hand to… another computer (T63-C)", () => {
  const env = (value: string) => value as EnvironmentId;
  const cloud: HandToComputer = {
    environmentId: env("cloud"),
    boxId: 2531,
    name: "uno-work",
    awake: true,
  };

  it("lists the connected boxes both daemons speak it on, never the chat's own computer", () => {
    const rows = [
      { environmentId: env("mac"), label: "Misha's Mac", status: "online", box: null },
      { environmentId: env("cloud"), label: "uno-work", status: "online", box: { id: 2531 } },
      { environmentId: env("old"), label: "old box", status: "online", box: { id: 7 } },
      { environmentId: env("night"), label: "night", status: "sleeping", box: { id: 9 } },
      { environmentId: null, label: "not connected", status: "online", box: { id: 11 } },
    ];
    const supportsRemote = (id: EnvironmentId) => id !== env("old");
    expect(handToComputers({ rows, environmentId: env("mac"), supportsRemote })).toEqual([
      cloud,
      { environmentId: env("night"), boxId: 9, name: "night", awake: false },
    ]);
    // A Mac is no box: from the cloud it isn't offered.
    expect(
      handToComputers({ rows, environmentId: env("cloud"), supportsRemote }).map((c) => c.name),
    ).toEqual(["night"]);
    // The chat's own daemon doesn't speak it: nothing on other computers.
    expect(handToComputers({ rows, environmentId: env("old"), supportsRemote })).toEqual([]);
  });

  it("offers the other computer's coordinators and assistants, keyed apart from local chats", () => {
    const there = [
      chat("Coordinator", { updatedAt: "2026-11-26T09:00:00.000Z" }),
      chat("w1", { spawnedByThreadId: id("Coordinator") }),
      chat("Uno", { assistantRole: "chat" }),
      // Handed to yet another computer: it handles nothing here.
      chat("Away", {
        assistantRole: "chat",
        handler: { threadId: id("x"), computer: { boxId: 9, name: "night" } },
      }),
    ];
    const groups = remoteHandToOptions({
      computers: [
        { computer: cloud, threads: there },
        {
          computer: { ...cloud, environmentId: env("night"), boxId: 9, awake: false },
          threads: there,
        },
      ],
      threads: [chat("me")],
      threadId: id("me"),
      query: "",
    });
    expect(groups[0]!.options.map((option) => option.title)).toEqual(["Coordinator", "Uno"]);
    expect(groups[0]!.options[0]!.computer).toEqual(cloud);
    expect(handToOptionKey(groups[0]!.options[0]!)).toBe("cloud/Coordinator");
    expect(groups[1]!.options[1]!.detail).toBe(`Assistant · ${HAND_TO_COPY.asleep}`);
  });

  it("offers no other computer to a chat that handles chats", () => {
    const here = [chat("me"), chat("sub", { handler: { threadId: id("me") } })];
    expect(
      remoteHandToOptions({
        computers: [{ computer: cloud, threads: [chat("Uno", { assistantRole: "chat" })] }],
        threads: here,
        threadId: id("me"),
        query: "",
      }),
    ).toEqual([]);
  });

  it("never offers a chat handed to another computer as a handler here", () => {
    const threads = [
      chat("me"),
      chat("away", { handler: { threadId: id("x"), computer: { boxId: 2531, name: "uno-work" } } }),
    ];
    expect(canHandle(threads, id("me"), threads[1]!)).toBe(false);
  });

  it("names the computer in the chip and the toast", () => {
    expect(HAND_TO_COPY.handledBy("Coordinator", "uno-work")).toBe(
      "Handled by “Coordinator” on uno-work",
    );
    expect(HAND_TO_COPY.handledBy("Coordinator", null)).toBe("Handled by “Coordinator”");
    expect(HAND_TO_COPY.handedToast("Uno", "uno-work")).toBe("Handed to “Uno” on uno-work");
  });
});
