import { describe, expect, it } from "vitest";

import { ONBOARDING_STARTERS, homeStarters, shortName, type StarterContext } from "./homeStarters";

/** Someone with projects: the row comes from their work. */
const EMPTY: StarterContext = { chatHints: [], projectCount: 3, files: [], sites: [] };

const hint = (id: string, label: string, folder: { cwd: string; name: string } | null = null) => ({
  id,
  label,
  prompt: `Do: ${label}`,
  folder,
});
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
      chatHints: [
        hint("a", "Fix the Safari test"),
        hint("b", "Send the invoice"),
        hint("c", "Add tests"),
      ],
    });
    expect(starters.map((s) => s.label)).toEqual([
      "Learn Uno Work",
      "Uno cloud services",
      "Fix the Safari test",
      "Send the invoice",
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
      chatHints: [hint("a", "Fix the Safari test"), hint("b", "Send the invoice")],
      files: [{ name: "budget.xlsx", isDirectory: false, modifiedAt: "2026-09-20T00:00:00Z" }],
      sites: [{ name: "blog" }],
    });
    expect(starters.map((s) => s.source)).toEqual(["chat", "file", "site", "chat"]);
    expect(starters.map((s) => s.label)).toEqual([
      "Fix the Safari test",
      "Make a chart from budget.xlsx",
      "Publish an update to blog",
      "Send the invoice",
    ]);
  });

  it("nothing is made from a chat's title: no hints, no chat chips", () => {
    expect(homeStarters({ ...EMPTY, sites: [{ name: "blog" }] }).map((s) => s.source)).toEqual([
      "site",
    ]);
  });

  it("carries the chat's folder so the composer switches there", () => {
    const folder = { cwd: "/home/uno/shop", name: "shop" };
    const [starter] = homeStarters({
      ...EMPTY,
      chatHints: [hint("a", "Fix the checkout total", folder)],
    });
    expect(starter!.folder).toEqual(folder);
    expect(starter!.prompt).toContain("checkout total");
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
      chatHints: [hint("a", "Fix the hero image")],
      notifications: [
        { id: "n1", source: "Office", title: "Boris commented on report.docx", body: null },
        { id: "n2", source: "Shop", title: "Payment failed for order 42", body: "Card declined." },
      ],
    });
    expect(starters.map((s) => s.label)).toEqual([
      "Fix the hero image",
      "Reply to “Boris commented on…”",
      "Look at Shop alert",
    ]);
    expect(starters[2]!.prompt).toContain("Card declined.");
  });
});

describe("duplicate starters", () => {
  it("shows one pill for several alerts of the same source", () => {
    const starters = homeStarters({
      ...EMPTY,
      notifications: [
        { id: "n1", source: "Ada", title: "Disk almost full", body: null },
        { id: "n2", source: "Ada", title: "Backup failed", body: null },
        { id: "n3", source: "Ada", title: "Site is down", body: null },
        { id: "n4", source: "Shop", title: "Payment failed", body: null },
      ],
    });
    expect(starters.map((s) => s.label)).toEqual(["Look at Ada alert", "Look at Shop alert"]);
    expect(starters[0]!.prompt).toContain("Disk almost full");
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
