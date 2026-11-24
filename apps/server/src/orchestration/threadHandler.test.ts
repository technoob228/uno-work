import { describe, expect, it } from "vitest";

import {
  chatsHandledBy,
  clipHandlerNote,
  handlerHopsAbove,
  handlerHopsBelow,
  handlerRefusal,
  type HandlerThreadView,
} from "./threadHandler.ts";

const chat = (
  id: string,
  extra: Partial<Omit<HandlerThreadView, "id">> & { handledBy?: string } = {},
): HandlerThreadView => ({
  id,
  spawnedByThreadId: extra.spawnedByThreadId ?? null,
  handler: extra.handledBy ? { threadId: extra.handledBy as never } : null,
  archivedAt: extra.archivedAt ?? null,
  deletedAt: extra.deletedAt ?? null,
});

describe("threadHandler", () => {
  const threads = [
    chat("a"),
    chat("b"),
    chat("c"),
    chat("a-child", { spawnedByThreadId: "a" }),
    chat("a-grandchild", { spawnedByThreadId: "a-child" }),
    chat("old", { archivedAt: "2026-11-01T00:00:00.000Z" }),
  ];

  it("allows a plain chat", () => {
    expect(handlerRefusal({ threads, threadId: "a", handlerThreadId: "b" })).toBeNull();
  });

  it("refuses self, missing, archived and the chat's own workers at any depth", () => {
    const code = (handlerThreadId: string) =>
      handlerRefusal({ threads, threadId: "a", handlerThreadId })?.code;
    expect(code("a")).toBe("handler_self");
    expect(code("zzz")).toBe("handler_missing");
    expect(code("old")).toBe("handler_archived");
    expect(code("a-child")).toBe("handler_subordinate");
    expect(code("a-grandchild")).toBe("handler_subordinate");
  });

  it("refuses loops, also through a middle chat", () => {
    const chain = [chat("a", { handledBy: "b" }), chat("b", { handledBy: "c" }), chat("c")];
    expect(handlerRefusal({ threads: chain, threadId: "c", handlerThreadId: "a" })?.code).toBe(
      "handler_loop",
    );
  });

  it("counts hops above and below; at most 3 in a chain", () => {
    const chain = [
      chat("a", { handledBy: "b" }),
      chat("b", { handledBy: "c" }),
      chat("c"),
      chat("d"),
      chat("e"),
    ];
    expect(handlerHopsAbove(chain, "a")).toBe(2);
    expect(handlerHopsBelow(chain, "c")).toBe(2);
    expect(handlerRefusal({ threads: chain, threadId: "c", handlerThreadId: "d" })).toBeNull();
    const longer = [...chain.slice(0, 2), chat("c", { handledBy: "d" }), chat("d"), chat("e")];
    expect(handlerRefusal({ threads: longer, threadId: "d", handlerThreadId: "e" })?.code).toBe(
      "handler_too_deep",
    );
  });

  it("lists the chats a handler handles, and clips notes", () => {
    const chain = [chat("a", { handledBy: "b" }), chat("x", { handledBy: "b" }), chat("b")];
    expect(chatsHandledBy(chain, "b")).toEqual(["a", "x"]);
    expect(clipHandlerNote("   ")).toBeNull();
    expect(clipHandlerNote("x".repeat(2_000))?.length).toBe(1_000);
  });
});
