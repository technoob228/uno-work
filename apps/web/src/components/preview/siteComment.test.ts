import type { UnoWorkSite } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({
  transport: "work-proxy" as "work-proxy" | "desktop" | "none",
  request: vi.fn(),
}));
vi.mock("../../account/unoAccount", () => ({
  accountTransport: () => account.transport,
  accountRequest: account.request,
}));

import {
  ownSiteOrigin,
  resetSiteCommentTokens,
  siteCommentToken,
  siteOriginsOf,
} from "./siteComment";

function site(patch: Partial<UnoWorkSite>): UnoWorkSite {
  return {
    slug: "cafe",
    url: "https://cafe.uno4.me/",
    customDomain: null,
    hasPassword: false,
    sizeBytes: null,
    updatedAt: null,
    ...patch,
  };
}

describe("own sites", () => {
  const sites = [
    site({}),
    site({ slug: "shop", url: "https://shop.example.com/", customDomain: "shop.example.com" }),
  ];

  it("knows every address of the person's sites", () => {
    expect([...siteOriginsOf(sites)].toSorted()).toEqual([
      "https://cafe.uno4.me",
      "https://shop.example.com",
      "https://shop.uno4.me",
    ]);
  });

  it("matches a page by its exact origin only", () => {
    expect(ownSiteOrigin("https://cafe.uno4.me/menu?x=1", sites)).toBe("https://cafe.uno4.me");
    expect(ownSiteOrigin("https://shop.example.com/", sites)).toBe("https://shop.example.com");
    expect(ownSiteOrigin("https://other.uno4.me/", sites)).toBeNull();
    expect(ownSiteOrigin("https://cafe.uno4.me.evil.com/", sites)).toBeNull();
    expect(ownSiteOrigin("http://cafe.uno4.me/", sites)).toBeNull();
    expect(ownSiteOrigin("garbage", sites)).toBeNull();
  });
});

describe("siteCommentToken", () => {
  beforeEach(() => {
    resetSiteCommentTokens();
    account.transport = "work-proxy";
    account.request.mockReset();
  });
  afterEach(() => resetSiteCommentTokens());

  it("asks Work's account once and reuses the token while it is fresh", async () => {
    account.request.mockResolvedValue({
      token: "v1.tok",
      origin: "https://cafe.uno4.me",
      expires_in: 600,
    });
    expect(await siteCommentToken("https://cafe.uno4.me")).toBe("v1.tok");
    expect(await siteCommentToken("https://cafe.uno4.me")).toBe("v1.tok");
    expect(account.request).toHaveBeenCalledTimes(1);
    expect(account.request).toHaveBeenCalledWith("POST", "/site-comment", {
      url: "https://cafe.uno4.me/",
    });
    // Close to its end: a new one.
    expect(await siteCommentToken("https://cafe.uno4.me", Date.now() + 590_000)).toBe("v1.tok");
    expect(account.request).toHaveBeenCalledTimes(2);
  });

  it("takes a refusal as no Comment for a while", async () => {
    account.request.mockRejectedValue(new Error("403 not_your_site"));
    expect(await siteCommentToken("https://x.uno4.me")).toBeNull();
    expect(await siteCommentToken("https://x.uno4.me")).toBeNull();
    expect(account.request).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer for another origin", async () => {
    account.request.mockResolvedValue({ token: "t", origin: "https://y.uno4.me", expires_in: 600 });
    expect(await siteCommentToken("https://x.uno4.me")).toBeNull();
  });

  it("is web-only (the desktop's <webview> reaches the page itself)", async () => {
    account.transport = "desktop";
    expect(await siteCommentToken("https://cafe.uno4.me")).toBeNull();
    expect(account.request).not.toHaveBeenCalled();
  });
});
