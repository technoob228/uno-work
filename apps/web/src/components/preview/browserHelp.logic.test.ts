import type { BrowserLivePage } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  browserHelpCopy,
  helpSiteHost,
  pageAskingForHelp,
  SESSION_STAYS_LINE,
} from "./browserHelp.logic";

describe("browserHelpCopy", () => {
  it("a sign-in names the site and the one thing to do", () => {
    const copy = browserHelpCopy({
      reason: "Sign in to github.com",
      url: "https://github.com/login?return_to=%2Fgetuno%2Flanding",
    });
    expect(copy.kind).toBe("signIn");
    expect(copy.title).toBe("The agent needs you to sign in to github.com");
    expect(copy.action).toBe("Sign in for the agent");
    expect(copy.activeTitle).toBe("You're signing in for the agent on github.com");
  });

  it("a 2FA code counts as signing in", () => {
    expect(browserHelpCopy({ reason: "GitHub asks for a 2FA code", url: null }).kind).toBe(
      "signIn",
    );
    expect(browserHelpCopy({ reason: "Enter the login code", url: null }).title).toBe(
      "The agent needs you to sign in",
    );
  });

  it("a captcha is its own ask", () => {
    const copy = browserHelpCopy({
      reason: "There's a captcha",
      url: "https://www.example.com/",
    });
    expect(copy.kind).toBe("captcha");
    expect(copy.title).toBe("The agent needs you to pass a check on example.com");
  });

  it("anything else: plain take control", () => {
    const copy = browserHelpCopy({ reason: "Pick the right account", url: "about:blank" });
    expect(copy.kind).toBe("other");
    expect(copy.action).toBe("Take control");
    expect(copy.title).toBe("The agent needs you");
  });

  it("says the password isn't stored", () => {
    expect(SESSION_STAYS_LINE).toContain("your password isn't stored");
  });
});

describe("helpSiteHost", () => {
  it("drops www and survives junk", () => {
    expect(helpSiteHost("https://www.github.com/x")).toBe("github.com");
    expect(helpSiteHost("not a url")).toBeNull();
    expect(helpSiteHost(undefined)).toBeNull();
  });
});

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
