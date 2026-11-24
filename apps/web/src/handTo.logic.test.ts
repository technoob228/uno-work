import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { canHandle, handToOptions, type HandToThreadView } from "./handTo.logic";

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
