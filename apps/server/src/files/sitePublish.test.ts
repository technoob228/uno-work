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

/** A scripted console: each call takes the next answer; records what was sent. */
function scriptedFetch(answers: Array<{ status: number; body: unknown } | "network-error">) {
  const calls: Array<{
    url: string;
    method: string;
    prefer: string | null;
    fields: Record<string, string>;
  }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const fields: Record<string, string> = {};
    if (init?.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) {
        if (typeof value === "string") fields[key] = value;
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      prefer: new Headers(init?.headers).get("prefer"),
      fields,
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected call ${url}`);
    if (answer === "network-error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** A fake clock: sleeping moves it on, nothing really waits. */
function fakeClock() {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
  };
}

const accepted = {
  deploy_id: "dpl_abc",
  status: "processing",
  status_url: "/api/v1/deploy/dpl_abc",
  retry_after_s: 2,
  slug: "team-site",
  url: "https://team-site.uno4.me/",
};

describe("background publish (28.10)", () => {
  it("sends the password and IP list with the upload and asks for a background publish", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      {
        status: 201,
        body: { slug: "team-site", has_password: true, ip_allowlist: ["203.0.113.7/32"] },
      },
    ]);
    const result = await publishToUnoHosting({
      path: nodePath.join(dir, "site"),
      slug: "team-site",
      password: "correct-horse-battery",
      ipAllowlist: [" 203.0.113.7 ", ""],
      apiKey: "k",
      baseUrl: "https://console.test",
      fetchImpl,
    });
    // One call: no separate password PUT after the publish.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.prefer).toBe("respond-async");
    expect(calls[0]?.fields).toMatchObject({
      slug: "team-site",
      password: "correct-horse-battery",
      ip_allowlist: "203.0.113.7",
      async: "1",
    });
    expect(result.hasPassword).toBe(true);
    expect(result.ipAllowlist).toEqual(["203.0.113.7/32"]);
  });

  it("sends no access fields when none were asked for", async () => {
    const { calls, fetchImpl } = scriptedFetch([{ status: 201, body: { slug: "team-site" } }]);
    const result = await publishToUnoHosting({
      path: nodePath.join(dir, "site"),
      slug: "team-site",
      apiKey: "k",
      baseUrl: "https://console.test",
      fetchImpl,
    });
    expect(calls[0]?.fields).not.toHaveProperty("password");
    expect(calls[0]?.fields).not.toHaveProperty("ip_allowlist");
    expect(result.hasPassword).toBeUndefined();
  });

  it("refuses a password hosting would refuse, before uploading", async () => {
    const { calls, fetchImpl } = scriptedFetch([]);
    await expect(
      publishToUnoHosting({
        path: nodePath.join(dir, "site"),
        password: "short",
        apiKey: "k",
        fetchImpl,
      }),
    ).rejects.toThrow(/10–128 characters/);
    expect(calls).toHaveLength(0);
  });

  it("follows a 202 to done and returns hosting's result", async () => {
    const clock = fakeClock();
    const { calls, fetchImpl } = scriptedFetch([
      { status: 202, body: accepted },
      { status: 200, body: { deploy_id: "dpl_abc", status: "processing", retry_after_s: 5 } },
      // Hosting restarting under us: keep polling.
      { status: 502, body: { error: "bad gateway" } },
      "network-error",
      {
        status: 200,
        body: {
          deploy_id: "dpl_abc",
          status: "done",
          url: "https://team-site.uno4.me/",
          result: {
            slug: "team-site",
            url: "https://team-site.uno4.me/",
            files_count: 2,
            size_bytes: 15,
            has_password: true,
          },
        },
      },
    ]);
    const result = await publishToUnoHosting({
      path: nodePath.join(dir, "site"),
      slug: "team-site",
      password: "correct-horse-battery",
      apiKey: "k",
      baseUrl: "https://console.test",
      fetchImpl,
      ...clock,
    });
    expect(calls.slice(1).map((call) => call.url)).toEqual(
      Array(4).fill("https://console.test/api/v1/deploy/dpl_abc"),
    );
    // retry_after_s from each answer: 2 s, then 5 s.
    expect(clock.slept.slice(0, 2)).toEqual([2000, 5000]);
    expect(result).toMatchObject({
      slug: "team-site",
      url: "https://team-site.uno4.me/",
      filesCount: 2,
      sizeBytes: 15,
      hasPassword: true,
    });
  });

  it("explains a background publish that failed like the same error answered at once", async () => {
    const clock = fakeClock();
    const { fetchImpl } = scriptedFetch([
      { status: 202, body: accepted },
      {
        status: 200,
        body: {
          deploy_id: "dpl_abc",
          status: "failed",
          error: "BUILD_NEEDED",
          message: "build first",
          http_status: 422,
          details: { error: "BUILD_NEEDED", tool: "Vite" },
        },
      },
    ]);
    await expect(
      publishToUnoHosting({
        path: nodePath.join(dir, "site"),
        apiKey: "k",
        baseUrl: "https://console.test",
        fetchImpl,
        ...clock,
      }),
    ).rejects.toThrow(/source of a Vite project — build it first/);
  });

  it("publishes once more when hosting restarted mid-publish", async () => {
    const clock = fakeClock();
    const { calls, fetchImpl } = scriptedFetch([
      { status: 202, body: accepted },
      {
        status: 200,
        body: {
          deploy_id: "dpl_abc",
          status: "failed",
          error: "INTERRUPTED",
          http_status: 503,
          message: "restarted",
        },
      },
      { status: 201, body: { slug: "team-site", files_count: 2 } },
    ]);
    const result = await publishToUnoHosting({
      path: nodePath.join(dir, "site"),
      slug: "team-site",
      apiKey: "k",
      baseUrl: "https://console.test",
      fetchImpl,
      ...clock,
    });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "POST"]);
    expect(calls[2]?.fields).toMatchObject({ slug: "team-site", async: "1" });
    expect(result.slug).toBe("team-site");
  });

  it("gives up on a second interruption with a plain message", async () => {
    const interrupted = { status: 503, body: { error: "INTERRUPTED", message: "restarted" } };
    const { calls, fetchImpl } = scriptedFetch([interrupted, interrupted]);
    await expect(
      publishToUnoHosting({
        path: nodePath.join(dir, "site"),
        apiKey: "k",
        baseUrl: "https://console.test",
        fetchImpl,
      }),
    ).rejects.toThrow(/restarted while publishing this site/);
    expect(calls).toHaveLength(2);
  });

  it("stops waiting after its deadline and says the site may still go live", async () => {
    const clock = fakeClock();
    const processing = {
      status: 200,
      body: { deploy_id: "dpl_abc", status: "processing", retry_after_s: 3 },
    };
    const { fetchImpl } = scriptedFetch([
      { status: 202, body: accepted },
      ...Array.from({ length: 10 }, () => processing),
    ]);
    await expect(
      publishToUnoHosting({
        path: nodePath.join(dir, "site"),
        apiKey: "k",
        baseUrl: "https://console.test",
        fetchImpl,
        waitMs: 10_000,
        ...clock,
      }),
    ).rejects.toThrow(/still publishing this site \(https:\/\/team-site\.uno4\.me\/\)/);
    expect(clock.now()).toBeLessThanOrEqual(10_000);
  });

  it("never follows a status address to another host", async () => {
    const clock = fakeClock();
    const { calls, fetchImpl } = scriptedFetch([
      {
        status: 202,
        body: { ...accepted, status_url: "https://evil.test/api/v1/deploy/dpl_abc" },
      },
      { status: 200, body: { status: "done", result: { slug: "team-site" } } },
    ]);
    await publishToUnoHosting({
      path: nodePath.join(dir, "site"),
      slug: "team-site",
      apiKey: "k",
      baseUrl: "https://console.test",
      fetchImpl,
      ...clock,
    });
    expect(calls[1]?.url).toBe("https://console.test/api/v1/deploy/dpl_abc");
  });
});
