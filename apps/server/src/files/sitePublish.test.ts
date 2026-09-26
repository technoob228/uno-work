import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publishToUnoHosting, liveSiteUrl, suggestSiteSlug } from "./sitePublish.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-publish-"));
  fs.mkdirSync(nodePath.join(dir, "site", "css"), { recursive: true });
  fs.writeFileSync(nodePath.join(dir, "site", "index.html"), "<h1>hi</h1>");
  fs.writeFileSync(nodePath.join(dir, "site", "css", "a.css"), "h1{}");
  fs.writeFileSync(nodePath.join(dir, "site", ".env"), "SECRET=1");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function recordingFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; auth: string | null; names: string[] }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const form = init?.body as FormData;
    const names = form
      .getAll("files")
      .map((file) => (file as File).name)
      .toSorted();
    calls.push({ url, auth: new Headers(init?.headers).get("authorization"), names });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("publishToUnoHosting", () => {
  it("publishes a folder with the machine token, without dotfiles", async () => {
    const { calls, fetchImpl } = recordingFetch(201, { slug: "team-site", files_count: 2 });
    const result = await publishToUnoHosting({
      path: nodePath.join(dir, "site"),
      slug: "team-site",
      apiKey: "uno_agt_machine",
      baseUrl: "https://console.test",
      fetchImpl,
    });
    expect(calls[0]?.url).toBe("https://console.test/api/v1/deploy");
    expect(calls[0]?.auth).toBe("Bearer uno_agt_machine");
    expect(calls[0]?.names).toEqual(["css/a.css", "index.html"]);
    // No url from hosting: the live pattern, not the old <slug>.uno4.dev (404).
    expect(result.url).toBe("https://team-site.sites.uno4.dev/");
  });

  it("returns the address Uno Hosting answers with", async () => {
    const { fetchImpl } = recordingFetch(201, {
      slug: "yoga",
      url: "https://yoga.sites.uno4.dev/",
      files_count: 2,
    });
    const result = await publishToUnoHosting({
      path: nodePath.join(dir, "site"),
      slug: "yoga",
      apiKey: "uno_agt_machine",
      fetchImpl,
    });
    expect(result.url).toBe("https://yoga.sites.uno4.dev/");
    expect(liveSiteUrl("javascript:alert(1)", "yoga")).toBe("https://yoga.sites.uno4.dev/");
  });

  it("explains a token that can't publish yet", async () => {
    const { fetchImpl } = recordingFetch(403, { error: "INSUFFICIENT_SCOPE" });
    await expect(
      publishToUnoHosting({ path: nodePath.join(dir, "site"), apiKey: "uno_agt_old", fetchImpl }),
    ).rejects.toThrow(/isn't allowed to publish sites yet/);
  });

  it("suggests readable site names", () => {
    expect(suggestSiteSlug("Q3 Report.html", "7f2a")).toBe("q3-report-7f2a");
    expect(suggestSiteSlug("Отчёт.html", "7f2a")).toBe("site-7f2a");
  });
});
