import { describe, expect, it } from "vitest";

import { listWorkSites, parseWorkSites } from "./workSites.ts";

describe("work sites", () => {
  it("keeps hosting's live address, a custom domain first, and drops rows without a slug", () => {
    const parsed = parseWorkSites({
      deploys: [
        { slug: "our-cafe-bot", url: "https://our-cafe-bot.uno4.me", has_password: false },
        { slug: "shop", url: "https://shop.uno4.me/", custom_domain: "shop.example.com" },
        { slug: "old" },
        { url: "https://x.uno4.me/" },
      ],
      storage_used_bytes: 1200,
      storage_limit_bytes: 500_000_000,
    });
    expect(parsed.sites.map((site) => site.url)).toEqual([
      "https://our-cafe-bot.uno4.me/",
      "https://shop.example.com/",
      "https://old.uno4.me/",
    ]);
    expect(parsed.storageUsedBytes).toBe(1200);
  });

  it("asks to sign in on a computer without a token, never calling the console", async () => {
    let called = false;
    const result = await listWorkSites({ uno: { apiKey: "unollm_ai_key_only" } } as never, {
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as never,
    });
    expect(result.availability).toBe("not_linked");
    expect(called).toBe(false);
  });

  it("reads the console with the machine token", async () => {
    const seen: string[] = [];
    const result = await listWorkSites({ uno: { apiKey: "", boxToken: "uno_agt_box" } } as never, {
      baseUrl: "https://console.test",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
        return new Response(
          JSON.stringify({ deploys: [{ slug: "a", url: "https://a.uno4.me/" }] }),
        );
      }) as never,
    });
    expect(seen).toEqual(["https://console.test/api/v1/work/sites Bearer uno_agt_box"]);
    expect(result.sites).toHaveLength(1);
  });
});
