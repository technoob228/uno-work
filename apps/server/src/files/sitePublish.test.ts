import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isSecretSiteFileName,
  liveSiteUrl,
  publishToUnoHosting,
  suggestSiteSlug,
} from "./sitePublish.ts";

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
    // No url from hosting: the production pattern (`<slug>.uno4.me`).
    expect(result.url).toBe("https://team-site.uno4.me/");
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
    expect(liveSiteUrl("javascript:alert(1)", "yoga")).toBe("https://yoga.uno4.me/");
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

describe("what stays on the computer", () => {
  it("keeps key files and .env home and says so in the result", async () => {
    fs.writeFileSync(nodePath.join(dir, "site", "service-account.json"), "{}");
    fs.writeFileSync(nodePath.join(dir, "site", "server.pem"), "k");
    const { calls, fetchImpl } = recordingFetch(201, {
      slug: "team-site",
      site_folder: "public",
      left_out: 3,
    });
    const result = await publishToUnoHosting({
      path: nodePath.join(dir, "site"),
      slug: "team-site",
      apiKey: "uno_agt_machine",
      baseUrl: "https://console.test",
      fetchImpl,
    });
    expect(calls[0]?.names).toEqual(["css/a.css", "index.html"]);
    expect(result.skipped).toEqual([
      ".env (hidden)",
      "server.pem (key file)",
      "service-account.json (key file)",
    ]);
    expect(result.skippedCount).toBe(3);
    expect(result.siteFolder).toBe("public");
    expect(result.leftOut).toBe(3);
  });

  it("matches Uno Hosting's key-file names", () => {
    for (const name of [
      "id_rsa",
      "id_ed25519_work",
      "credentials.json",
      "client_secret_123.json",
      "secrets.yaml",
      "my-firebase-adminsdk-x.json",
      "terraform.tfstate",
    ]) {
      expect(isSecretSiteFileName(name), name).toBe(true);
    }
    for (const name of ["id_rsa.pub", "index.html", "app.js", "secret-santa.html", "data.json"]) {
      expect(isSecretSiteFileName(name), name).toBe(false);
    }
  });

  it("says plainly when the folder is an app or needs a build", async () => {
    const backend = recordingFetch(422, {
      error: "BACKEND_NEEDS_COMPUTER",
      markers: ["server.js"],
    });
    await expect(
      publishToUnoHosting({
        path: nodePath.join(dir, "site"),
        apiKey: "k",
        baseUrl: "https://console.test",
        fetchImpl: backend.fetchImpl,
      }),
    ).rejects.toThrow(/app with a server side/);
    const build = recordingFetch(422, { error: "BUILD_NEEDED", tool: "Vite" });
    await expect(
      publishToUnoHosting({
        path: nodePath.join(dir, "site"),
        apiKey: "k",
        baseUrl: "https://console.test",
        fetchImpl: build.fetchImpl,
      }),
    ).rejects.toThrow(/source of a Vite project — build it first/);
  });
});
