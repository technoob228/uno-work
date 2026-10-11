import { describe, expect, it } from "vitest";

import { ONBOARDING_STARTERS, homeStarters, shortName, type StarterContext } from "./homeStarters";

/** Someone with projects: the row comes from their work. */
const EMPTY: StarterContext = { chats: [], projectCount: 3, files: [], sites: [] };
/** Someone still getting on board. */
const NEWCOMER: StarterContext = { ...EMPTY, projectCount: 0 };

describe("homeStarters", () => {
  it("getting on board (fewer than two projects): learn Uno Work and its cloud first", () => {
    expect(homeStarters(NEWCOMER).map((s) => s.label)).toEqual([
      "Learn Uno Work",
      "Uno cloud services",
      "Make me an app that…",
      "Publish a site from a folder",
    ]);
    expect(homeStarters({ ...NEWCOMER, projectCount: 1 }).slice(0, 2)).toEqual(ONBOARDING_STARTERS);
  });

  it("getting on board: the person's own work follows the onboarding pair", () => {
    const starters = homeStarters({
      ...NEWCOMER,
      projectCount: 1,
      chats: [
        { title: "Sales report", activityAt: 2, folder: null },
        { title: "Invoice bot", activityAt: 1, folder: null },
        { title: "Landing", activityAt: 0, folder: null },
      ],
    });
    expect(starters.map((s) => s.label)).toEqual([
      "Learn Uno Work",
      "Uno cloud services",
      "Next step for “Sales report”",
      "Next step for “Invoice bot”",
    ]);
  });

  it("with projects, the row is the person's work and nothing generic", () => {
    const starters = homeStarters({ ...EMPTY, sites: [{ name: "shop.example.com" }] });
    expect(starters.map((s) => s.label)).toEqual(["Publish an update to shop.example.com"]);
  });

  it("with projects but nothing to go on, the onboarding starters come back", () => {
    expect(homeStarters(EMPTY).map((s) => s.source)).toEqual([
      "onboarding",
      "onboarding",
      "generic",
      "generic",
    ]);
  });

  it("takes one from each source in turn, max four", () => {
    const starters = homeStarters({
      ...EMPTY,
      chats: [
        { title: "Sales report", activityAt: 3, folder: null },
        { title: "Invoice bot", activityAt: 2, folder: null },
        { title: "Old landing", activityAt: 1, folder: null },
      ],
      files: [{ name: "budget.xlsx", isDirectory: false, modifiedAt: "2026-09-20T00:00:00Z" }],
      sites: [{ name: "blog" }],
    });
    expect(starters.map((s) => s.source)).toEqual(["chat", "file", "site", "chat"]);
    expect(starters.map((s) => s.label)).toEqual([
      "Next step for “Sales report”",
      "Make a chart from budget.xlsx",
      "Publish an update to blog",
      "Next step for “Invoice bot”",
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

  it("skips chats already shown under Continue, then uses other sources", () => {
    const starters = homeStarters({
      ...EMPTY,
      chats: [
        { title: "Sales report", activityAt: 3, folder: null },
        { title: "Invoice bot", activityAt: 2, folder: null },
      ],
      sites: [{ name: "blog" }],
      continueTitles: ["Sales report", "invoice bot "],
    });
    expect(starters.map((s) => s.label)).toEqual(["Publish an update to blog"]);
  });

  it("keeps older chats that are not under Continue", () => {
    const starters = homeStarters({
      ...EMPTY,
      chats: [
        { title: "Sales report", activityAt: 3, folder: null },
        { title: "Old landing", activityAt: 1, folder: null },
      ],
      continueTitles: ["Sales report"],
    });
    expect(starters.map((s) => s.label)).toEqual(["Next step for “Old landing”"]);
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

  it("only suggests files with an obvious task, newest first — never a folder to tidy", () => {
    const starters = homeStarters({
      ...EMPTY,
      files: [
        { name: "photo.jpg", isDirectory: false, modifiedAt: "2026-09-24T00:00:00Z" },
        { name: "notes.md", isDirectory: false, modifiedAt: "2026-09-22T00:00:00Z" },
        { name: "q3.xlsx", isDirectory: false, modifiedAt: "2026-09-23T00:00:00Z" },
        { name: "projects", isDirectory: true, modifiedAt: "2026-09-25T00:00:00Z" },
        { name: ".cache", isDirectory: true, modifiedAt: "2026-09-25T00:00:00Z" },
      ],
    });
    expect(starters.map((s) => s.label)).toEqual([
      "Make a chart from q3.xlsx",
      "Summarize notes.md",
    ]);
  });

  it("is deterministic", () => {
    const context: StarterContext = { ...EMPTY, sites: [{ name: "blog" }] };
    expect(homeStarters(context)).toEqual(homeStarters(context));
  });
});

describe("notification starters", () => {
  it("offers a reply for comments and a look for other alerts, after a chat", () => {
    const starters = homeStarters({
      ...EMPTY,
      chats: [{ title: "Old landing", activityAt: 1, folder: null }],
      notifications: [
        { id: "n1", source: "Office", title: "Boris commented on report.docx", body: null },
        { id: "n2", source: "Shop", title: "Payment failed for order 42", body: "Card declined." },
      ],
    });
    expect(starters.map((s) => s.label)).toEqual([
      "Next step for “Old landing”",
      "Reply to “Boris commented on…”",
      "Look at Shop alert",
    ]);
    expect(starters[2]!.prompt).toContain("Card declined.");
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
