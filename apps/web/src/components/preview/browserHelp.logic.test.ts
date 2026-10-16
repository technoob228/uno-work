import type { BrowserLivePage } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { pageAskingForHelp } from "./browserHelp.logic";

const page = (over: Partial<BrowserLivePage>): BrowserLivePage =>
  ({
    pageId: "p1",
    url: "https://x.com/login",
    title: "Log in",
    control: "agent",
    help: null,
    attention: 1,
    agentWaiting: false,
    width: 1280,
    height: 800,
    ...over,
  }) as BrowserLivePage;

describe("pageAskingForHelp", () => {
  it("finds the page of this chat that waits on the person", () => {
    const asking = page({
      pageId: "p2",
      context: { threadId: "t1" } as BrowserLivePage["context"],
      help: { reason: "Sign in to x.com", requestedAt: "2026-10-16T03:00:00Z" },
    });
    expect(pageAskingForHelp([page({}), asking], "t1")?.pageId).toBe("p2");
  });

  it("ignores other chats and pages that don't ask", () => {
    const other = page({
      context: { threadId: "t2" } as BrowserLivePage["context"],
      help: { reason: "2FA", requestedAt: "2026-10-16T03:00:00Z" },
    });
    expect(pageAskingForHelp([other, page({ context: { threadId: "t1" } as never })], "t1")).toBe(
      null,
    );
  });

  it("the latest ask wins", () => {
    const older = page({
      pageId: "a",
      context: { threadId: "t1" } as BrowserLivePage["context"],
      help: { reason: "old", requestedAt: "2026-10-16T02:00:00Z" },
    });
    const newer = page({
      pageId: "b",
      context: { threadId: "t1" } as BrowserLivePage["context"],
      help: { reason: "new", requestedAt: "2026-10-16T03:00:00Z" },
    });
    expect(pageAskingForHelp([older, newer], "t1")?.pageId).toBe("b");
  });
});
