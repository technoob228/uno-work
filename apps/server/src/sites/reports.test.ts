import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildReportPage,
  isReportSlug,
  MAX_REPORTS,
  newReportPassword,
  newReportSlug,
  pickReportSlug,
  readReports,
  recordReport,
  refreshReportLink,
  reportOfSource,
  reportOfThread,
  reportsFile,
  type ReportEntry,
} from "./reports.ts";
import { validateSiteSlug } from "../files/sitePublish.ts";

const entry = (over: Partial<ReportEntry> = {}): ReportEntry => ({
  slug: "r-0123456789",
  threadId: "t1",
  title: "Отчёт",
  source: "/a/report.md",
  url: "https://r-0123456789.uno4.me/?k=abc",
  expiresAtMs: 2_000,
  createdAtMs: 1_000,
  ...over,
});

describe("report slugs", () => {
  it("are valid site names, each its own", () => {
    const slug = newReportSlug();
    expect(isReportSlug(slug)).toBe(true);
    expect(validateSiteSlug(slug)).toBe(slug);
    expect(newReportSlug()).not.toBe(slug);
  });

  it("don't catch the person's own sites", () => {
    expect(isReportSlug("r-menu")).toBe(false);
    expect(isReportSlug("report-2026-10")).toBe(false);
  });

  it("passwords fit hosting's 10-128 chars", () => {
    expect(newReportPassword().length).toBeGreaterThanOrEqual(10);
    expect(newReportPassword().length).toBeLessThanOrEqual(128);
  });
});

describe("pickReportSlug", () => {
  const input = { threadId: "t1", source: "/a/new.md", nowMs: 5_000 };

  it("gives each report its own slug", () => {
    expect(pickReportSlug([], input, () => "r-aaaaaaaaaa")).toEqual({
      slug: "r-aaaaaaaaaa",
      fallbackSlug: undefined,
    });
  });

  it("updates the same file's report from the same chat", () => {
    const entries = [entry({ source: "/a/new.md", slug: "r-bbbbbbbbbb" })];
    expect(pickReportSlug(entries, input).slug).toBe("r-bbbbbbbbbb");
  });

  it("keeps a dead link's slug to fall back on at the account's limit", () => {
    const entries = [entry({ slug: "r-cccccccccc" })];
    expect(pickReportSlug(entries, input, () => "r-aaaaaaaaaa")).toEqual({
      slug: "r-aaaaaaaaaa",
      fallbackSlug: "r-cccccccccc",
    });
  });

  it("reuses the oldest dead slug once the list is full", () => {
    const entries = Array.from({ length: MAX_REPORTS }, (_, index) =>
      entry({ slug: `r-${String(index).padStart(10, "0")}` }),
    );
    expect(pickReportSlug(entries, input).slug).toBe("r-0000000000");
  });

  it("never takes a slug whose link still works", () => {
    const entries = [entry({ expiresAtMs: 9_000 })];
    expect(pickReportSlug(entries, input, () => "r-aaaaaaaaaa").fallbackSlug).toBeUndefined();
  });
});

describe("report lookups", () => {
  it("finds the chat's latest live report of this turn", () => {
    const entries = [
      entry({ slug: "r-aaaaaaaaaa", expiresAtMs: 9_000 }),
      entry({ slug: "r-bbbbbbbbbb", expiresAtMs: 9_000, createdAtMs: 1_500 }),
    ];
    expect(reportOfThread(entries, "t1", { sinceMs: 0, nowMs: 3_000 })?.slug).toBe("r-bbbbbbbbbb");
    expect(reportOfThread(entries, "t1", { sinceMs: 2_000, nowMs: 3_000 })).toBeNull();
    expect(reportOfThread(entries, "t2", { sinceMs: 0, nowMs: 3_000 })).toBeNull();
  });

  it("skips a dead link", () => {
    expect(reportOfSource([entry()], "/a/report.md", 1_500)?.slug).toBe("r-0123456789");
    expect(reportOfSource([entry()], "/a/report.md", 2_500)).toBeNull();
  });
});

describe("the list on disk", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "uno-reports-"));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it("keeps entries private and replaces by slug", async () => {
    await recordReport(home, entry());
    await recordReport(home, entry({ title: "Новый" }));
    expect((await readReports(home)).map((item) => item.title)).toEqual(["Новый"]);
    expect((await stat(reportsFile(home))).mode & 0o777).toBe(0o600);
  });

  it("refreshes a known report's link and ignores others", async () => {
    await recordReport(home, entry());
    await refreshReportLink(home, "r-0123456789", { url: "https://x/", expiresAtMs: null });
    await refreshReportLink(home, "site", { url: "https://y/", expiresAtMs: 1 });
    expect(await readReports(home)).toEqual([entry({ url: "https://x/", expiresAtMs: null })]);
  });

  it("reads a broken file as empty", async () => {
    await recordReport(home, entry());
    await writeFile(reportsFile(home), "{");
    expect(await readReports(home)).toEqual([]);
  });

  it("inlines an allowed relative image and refuses one the gate refuses", async () => {
    const file = path.join(home, "report.md");
    await writeFile(path.join(home, "chart.png"), "png");
    await writeFile(path.join(home, "key.png"), "secret");
    await writeFile(file, "# Отчёт\n\n![ok](chart.png) ![no](key.png)");
    const page = await buildReportPage({
      file,
      title: undefined,
      resolve: async (candidate) => (candidate.endsWith("chart.png") ? candidate : null),
    });
    expect(page.title).toBe("Отчёт");
    expect(page.html).toContain(`data:image/png;base64,${btoa("png")}`);
    expect(page.html).not.toContain(btoa("secret"));
  });

  it("titles a report without a heading from the file name", async () => {
    const file = path.join(home, "WEEKLY-REPORT_2026.md");
    await writeFile(file, "text");
    const page = await buildReportPage({ file, title: undefined, resolve: async () => null });
    expect(page.title).toBe("WEEKLY REPORT 2026");
  });
});
