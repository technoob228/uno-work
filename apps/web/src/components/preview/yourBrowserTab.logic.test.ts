import { describe, expect, it } from "vitest";

import type { BrowserLivePage, BrowserLiveSetup } from "@t3tools/contracts";

import {
  browserTabMode,
  findYourBrowserPage,
  isBlankPageUrl,
  isLeftoverPage,
  isPersonTabPage,
  yourBrowserStep,
  yourBrowserTabKey,
} from "./yourBrowserTab.logic";

function page(patch: Partial<BrowserLivePage> = {}): BrowserLivePage {
  return {
    pageId: "pg_1",
    url: "https://example.com/",
    title: "Example",
    control: "human",
    help: null,
    attention: 0,
    agentWaiting: false,
    width: 1280,
    height: 800,
    ...patch,
  };
}

const READY: { setup: BrowserLiveSetup } = { setup: { status: "ready" } as BrowserLiveSetup };
const INSTALLING: { setup: BrowserLiveSetup } = {
  setup: { status: "installing" } as BrowserLiveSetup,
};

describe("browserTabMode", () => {
  it("the Mac app keeps its own page in the panel, computer or not", () => {
    expect(browserTabMode({ desktopApp: true, computer: true })).toBe("panel");
    expect(browserTabMode({ desktopApp: true, computer: false })).toBe("panel");
  });

  it("the web version shows the computer's browser", () => {
    expect(browserTabMode({ desktopApp: false, computer: true })).toBe("computer");
  });

  it("the web version with no computer opens the page outside, as before", () => {
    expect(browserTabMode({ desktopApp: false, computer: false })).toBe("outside");
  });
});

describe("your tab's page", () => {
  it("one key per load of the app and tab", () => {
    expect(yourBrowserTabKey("w1-a", "browser-3")).toBe("w1-a.browser-3");
    expect(yourBrowserTabKey("w1-b", "browser-3")).not.toBe(yourBrowserTabKey("w1-a", "browser-3"));
  });

  it("closes only this window's leftovers from earlier loads", () => {
    const current = { windowKey: "w1", sessionKey: "w1-now" };
    expect(isLeftoverPage(page({ tab: "w1-old.browser-1" }), current)).toBe(true);
    expect(isLeftoverPage(page({ tab: "w1-now.browser-1" }), current)).toBe(false);
    // Another window's tab, the agent's page.
    expect(isLeftoverPage(page({ tab: "w2-x.browser-1" }), current)).toBe(false);
    expect(isLeftoverPage(page({ context: { threadId: "t1" } }), current)).toBe(false);
  });

  it("finds only this tab's page — not the agent's, not another tab's", () => {
    const agents = page({ pageId: "pg_a", context: { threadId: "t1" } });
    const other = page({ pageId: "pg_o", tab: "dev1.browser-2" });
    const mine = page({ pageId: "pg_m", tab: "dev1.browser-3" });
    const state = { pages: [agents, other, mine] };
    expect(findYourBrowserPage(state, "dev1.browser-3")?.pageId).toBe("pg_m");
    expect(findYourBrowserPage(state, "dev1.browser-9")).toBeNull();
    expect(findYourBrowserPage(null, "dev1.browser-3")).toBeNull();
  });

  it("a person's tab page is never the agent's or an app window's", () => {
    expect(isPersonTabPage(page({ tab: "dev1.browser-3" }))).toBe(true);
    expect(isPersonTabPage(page({ context: { threadId: "t1" } }))).toBe(false);
    expect(isPersonTabPage(page({ tab: "" }))).toBe(false);
  });

  it("a blank page has no address to show", () => {
    expect(isBlankPageUrl("about:blank")).toBe(true);
    expect(isBlankPageUrl("")).toBe(true);
    expect(isBlankPageUrl("https://example.com/")).toBe(false);
  });
});

describe("yourBrowserStep", () => {
  it("waits for the computer before asking", () => {
    expect(yourBrowserStep({ state: null, page: null, asking: false, error: null })).toEqual({
      view: "connecting",
      ask: false,
    });
  });

  it("asks once when there's no page yet, then waits", () => {
    expect(yourBrowserStep({ state: READY, page: null, asking: false, error: null })).toEqual({
      view: "opening",
      ask: true,
    });
    expect(yourBrowserStep({ state: READY, page: null, asking: true, error: null })).toEqual({
      view: "opening",
      ask: false,
    });
  });

  it("shows the setup while the browser is being set up", () => {
    expect(yourBrowserStep({ state: INSTALLING, page: null, asking: true, error: null })).toEqual({
      view: "setup",
      ask: false,
    });
  });

  it("shows the page once it's there", () => {
    expect(yourBrowserStep({ state: READY, page: page(), asking: true, error: null })).toEqual({
      view: "page",
      ask: false,
    });
  });

  it("an error stays on screen — no asking again in a loop", () => {
    expect(yourBrowserStep({ state: READY, page: null, asking: false, error: "boom" })).toEqual({
      view: "error",
      ask: false,
    });
  });
});
