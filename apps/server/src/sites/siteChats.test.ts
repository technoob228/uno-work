import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  forgetSiteChat,
  readSiteChats,
  recordSiteChat,
  siteChatsFile,
  trimSiteChats,
} from "./siteChats.ts";
import { withSiteChats } from "./workSites.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const home = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "uno-site-chats-"));
  dirs.push(dir);
  return dir;
};

describe("which chat made a site", () => {
  it("remembers the chat of the latest publish and forgets an unpublished site", async () => {
    const dir = home();
    await recordSiteChat(dir, "bakery", { threadId: "t1", title: "A site for my bakery" });
    await recordSiteChat(dir, "menu", { threadId: "t2", title: "Translate the menu" });
    await recordSiteChat(dir, "bakery", { threadId: "t3", title: "Fix the contact form" });
    const chats = await readSiteChats(dir);
    expect(chats["bakery"]).toMatchObject({ threadId: "t3", title: "Fix the contact form" });
    expect(chats["menu"]?.threadId).toBe("t2");
    await forgetSiteChat(dir, "bakery");
    expect(Object.keys(await readSiteChats(dir))).toEqual(["menu"]);
    // Only this person reads it.
    expect(readFileSync(siteChatsFile(dir), "utf8")).toContain("menu");
  });

  it("keeps every line when sites are published at the same moment", async () => {
    const dir = home();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        recordSiteChat(dir, `site-${i}`, { threadId: `t${i}`, title: `Chat ${i}` }),
      ),
    );
    expect(Object.keys(await readSiteChats(dir))).toHaveLength(12);
  });

  it("a site called constructor is just a site", async () => {
    const dir = home();
    await recordSiteChat(dir, "bakery", { threadId: "t1", title: "Bakery" });
    const sites = {
      availability: "ok" as const,
      sites: [
        {
          slug: "constructor",
          url: "https://constructor.uno4.me/",
          customDomain: null,
          hasPassword: false,
          sizeBytes: null,
          updatedAt: null,
        },
      ],
      storageUsedBytes: null,
      storageLimitBytes: null,
      message: null,
    };
    expect(withSiteChats(sites, await readSiteChats(dir)).sites[0]?.madeIn).toBeUndefined();
  });

  it("reads nothing from a missing or broken file", async () => {
    const dir = home();
    expect(await readSiteChats(dir)).toEqual({});
    mkdirSync(path.join(dir, ".uno"), { recursive: true });
    writeFileSync(siteChatsFile(dir), "{not json");
    expect(await readSiteChats(dir)).toEqual({});
    writeFileSync(siteChatsFile(dir), JSON.stringify({ a: { title: "no thread" }, b: 5 }));
    expect(await readSiteChats(dir)).toEqual({});
  });

  it("keeps the newest sites when the record grows", () => {
    const many = Object.fromEntries(
      Array.from({ length: 510 }, (_, i) => [
        `s${i}`,
        { threadId: "t", title: "", at: new Date(2026, 0, 1, 0, i).toISOString() },
      ]),
    );
    const kept = trimSiteChats(many);
    expect(Object.keys(kept)).toHaveLength(500);
    expect(kept["s509"]).toBeDefined();
    expect(kept["s0"]).toBeUndefined();
  });

  it("adds Made in chat to the console's list", () => {
    const sites = {
      availability: "ok" as const,
      sites: [
        {
          slug: "bakery",
          url: "https://bakery.uno4.me/",
          customDomain: null,
          hasPassword: false,
          sizeBytes: null,
          updatedAt: null,
        },
        {
          slug: "elsewhere",
          url: "https://elsewhere.uno4.me/",
          customDomain: null,
          hasPassword: false,
          sizeBytes: null,
          updatedAt: null,
        },
      ],
      storageUsedBytes: null,
      storageLimitBytes: null,
      message: null,
    };
    const merged = withSiteChats(sites, {
      bakery: { threadId: "t1", title: "A site for my bakery", at: "" },
    });
    expect(merged.sites[0]?.madeIn).toEqual({ threadId: "t1", title: "A site for my bakery" });
    expect(merged.sites[1]?.madeIn).toBeUndefined();
  });
});
