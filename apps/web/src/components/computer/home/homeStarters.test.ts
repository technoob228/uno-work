import { describe, expect, it } from "vitest";

import { GENERIC_STARTERS, homeStarters, shortName, type StarterContext } from "./homeStarters";

const EMPTY: StarterContext = { chats: [], apps: [], files: [], sites: [] };

describe("homeStarters", () => {
  it("falls back to the generic starters only when there is no context", () => {
    expect(homeStarters(EMPTY)).toEqual(GENERIC_STARTERS.slice(0, 4));
  });

  it("never mixes generic starters in when there is some context", () => {
    const starters = homeStarters({
      ...EMPTY,
      sites: [{ name: "shop.example.com" }],
    });
    expect(starters.map((s) => s.label)).toEqual(["Publish an update to shop.example.com"]);
    expect(starters.every((s) => s.source !== "generic")).toBe(true);
  });

  it("takes one from each source in turn, max four", () => {
    const starters = homeStarters({
      chats: [
        { title: "Sales report", activityAt: 2, folder: null },
        { title: "Invoice bot", activityAt: 1, folder: null },
      ],
      apps: [{ name: "Notes", kind: "registered" }],
      files: [{ name: "budget.xlsx", isDirectory: false, modifiedAt: "2026-09-20T00:00:00Z" }],
      sites: [{ name: "blog" }],
    });
    expect(starters.map((s) => s.source)).toEqual(["chat", "app", "file", "site"]);
    expect(starters.map((s) => s.label)).toEqual([
      "Next step for “Sales report”",
      "Add a login page to Notes",
      "Make a chart from budget.xlsx",
      "Publish an update to blog",
    ]);
  });

  it("fills the row from a single rich source", () => {
    const starters = homeStarters({
      ...EMPTY,
      chats: ["a report", "b report", "c report", "d report", "e report"].map((title, i) => ({
        title,
        activityAt: i,
        folder: null,
      })),
    });
    expect(starters).toHaveLength(4);
    expect(starters[0]!.label).toContain("e report");
  });

  it("skips placeholder chat titles and duplicates", () => {
    const starters = homeStarters({
      ...EMPTY,
      chats: [
        { title: "New thread", activityAt: 3, folder: null },
        { title: "Landing page", activityAt: 2, folder: null },
        { title: "landing page", activityAt: 1, folder: null },
      ],
    });
    expect(starters.map((s) => s.label)).toEqual(["Next step for “Landing page”"]);
  });

  it("carries the chat's folder so the composer switches there", () => {
    const folder = { cwd: "/home/uno/shop", name: "shop" };
    const [starter] = homeStarters({
      ...EMPTY,
      chats: [{ title: "Shop checkout", activityAt: 1, folder }],
    });
    expect(starter!.folder).toEqual(folder);
    expect(starter!.prompt).toContain("Shop checkout");
  });

  it("phrases apps by how they got onto the computer, built-here first", () => {
    const starters = homeStarters({
      ...EMPTY,
      apps: [
        { name: "nginx", kind: "container" },
        { name: "Nextcloud", kind: "store" },
        { name: "Todo", kind: "registered" },
      ],
    });
    expect(starters.map((s) => s.label)).toEqual([
      "Add a login page to Todo",
      "Set up a backup for Nextcloud",
      "Explain what nginx does",
    ]);
  });

  it("only suggests files with an obvious task, newest first", () => {
    const starters = homeStarters({
      ...EMPTY,
      files: [
        { name: "photo.jpg", isDirectory: false, modifiedAt: "2026-09-24T00:00:00Z" },
        { name: "notes.md", isDirectory: false, modifiedAt: "2026-09-22T00:00:00Z" },
        { name: "Downloads", isDirectory: true, modifiedAt: "2026-09-23T00:00:00Z" },
        { name: ".cache", isDirectory: true, modifiedAt: "2026-09-25T00:00:00Z" },
      ],
    });
    expect(starters.map((s) => s.label)).toEqual(["Tidy up Downloads", "Summarize notes.md"]);
  });

  it("is deterministic", () => {
    const context: StarterContext = {
      ...EMPTY,
      apps: [{ name: "Notes", kind: "registered" }],
      sites: [{ name: "blog" }],
    };
    expect(homeStarters(context)).toEqual(homeStarters(context));
  });
});

describe("shortName", () => {
  it("keeps short names and cuts long ones at a word", () => {
    expect(shortName("Notes")).toBe("Notes");
    expect(shortName("A very long chat title about the quarterly sales report")).toBe(
      "A very long chat title about…",
    );
  });
});
