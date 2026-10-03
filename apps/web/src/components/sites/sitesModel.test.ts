import { describe, expect, it } from "vitest";

import {
  changeSitePrompt,
  parseAppsSitesSearch,
  siteRows,
  siteStatus,
  tabsShowingSite,
  updatedAgo,
} from "./sitesModel";

describe("sites screen model", () => {
  it("finds the panel tabs that show an unpublished site, and only those", () => {
    const tabs = [
      { id: "live", kind: "live-browser", url: "https://cafe.uno4.me/menu" },
      { id: "web", kind: "browser", url: "https://cafe.uno4.me/" },
      { id: "other", kind: "browser", url: "https://cafe.example.com/" },
      { id: "file", kind: "html", url: "https://cafe.uno4.me/" },
      { id: "blank", kind: "browser", url: "" },
      { id: "app", kind: "app" },
    ];
    expect(tabsShowingSite(tabs, "https://cafe.uno4.me/")).toEqual(["live", "web"]);
    expect(tabsShowingSite(tabs, "not an address")).toEqual([]);
  });

  it("the status pill says who can open the site, not the same word on every row", () => {
    expect(siteStatus({ hasPassword: false })).toEqual({ label: "Live", locked: false });
    expect(siteStatus({ hasPassword: true })).toEqual({ label: "Password", locked: true });
  });

  it("lists newest first with a readable address", () => {
    const rows = siteRows([
      {
        slug: "old",
        url: "https://old.uno4.me/",
        customDomain: null,
        hasPassword: false,
        sizeBytes: null,
        updatedAt: "2026-09-01T10:00:00Z",
      },
      {
        slug: "our-cafe-bot",
        url: "https://our-cafe-bot.uno4.me/",
        customDomain: null,
        hasPassword: true,
        sizeBytes: 1200,
        updatedAt: "2026-10-02T01:21:10Z",
        madeIn: { threadId: "t1", title: "A bot for our cafe" },
      },
    ]);
    expect(rows.map((row) => row.host)).toEqual(["our-cafe-bot.uno4.me", "old.uno4.me"]);
    expect(rows[0]?.hasPassword).toBe(true);
    // "Made in chat …": the chat that published it; a site made elsewhere has none.
    expect(rows[0]?.madeIn).toEqual({ threadId: "t1", title: "A bot for our cafe" });
    expect(rows[1]?.madeIn).toBeNull();
  });

  it("says when it changed in plain words", () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    expect(updatedAgo("2026-10-02T09:59:50Z", now)).toBe("just now");
    expect(updatedAgo("2026-10-02T07:00:00Z", now)).toBe("3 hours ago");
    expect(updatedAgo("2026-09-29T10:00:00Z", now)).toBe("3 days ago");
    expect(updatedAgo(null, now)).toBeNull();
  });

  it("asks Uno to change a site under the same address", () => {
    expect(changeSitePrompt({ slug: "a", url: "https://a.uno4.me/" })).toContain("same address");
  });
});

describe("Apps & sites tabs", () => {
  it("reads ?tab=apps|sites and ignores anything else", () => {
    expect(parseAppsSitesSearch({ tab: "sites" })).toEqual({ tab: "sites" });
    expect(parseAppsSitesSearch({ tab: "apps" })).toEqual({ tab: "apps" });
    expect(parseAppsSitesSearch({ tab: "x" })).toEqual({});
    expect(parseAppsSitesSearch({})).toEqual({});
  });
});
