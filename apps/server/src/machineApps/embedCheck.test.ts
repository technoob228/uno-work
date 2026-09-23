import { describe, expect, it } from "vitest";

import { checkEmbed, decideEmbed, frameAncestorsOf, sourceMatches } from "./embedCheck.ts";

const WORK = "https://app.uno4.work";
const APP = "https://nextcloud-box.app.uno4.dev/login";

describe("sourceMatches", () => {
  const embedder = new URL(WORK);
  const app = new URL(APP);
  it("handles keywords, schemes and hosts", () => {
    expect(sourceMatches("'none'", embedder, app)).toBe(false);
    expect(sourceMatches("'self'", embedder, app)).toBe(false);
    expect(sourceMatches("'self'", new URL("https://nextcloud-box.app.uno4.dev"), app)).toBe(true);
    expect(sourceMatches("*", embedder, app)).toBe(true);
    expect(sourceMatches("https:", embedder, app)).toBe(true);
    expect(sourceMatches("https://app.uno4.work", embedder, app)).toBe(true);
    expect(sourceMatches("app.uno4.work", embedder, app)).toBe(true);
    expect(sourceMatches("https://*.uno4.work", embedder, app)).toBe(true);
    expect(sourceMatches("https://*.app.uno4.work", embedder, app)).toBe(false);
    expect(sourceMatches("https://app.uno4.work:8443", embedder, app)).toBe(false);
    expect(sourceMatches("http://app.uno4.work", embedder, app)).toBe(true);
    expect(sourceMatches("chrome-extension:", embedder, app)).toBe(false);
  });
});

describe("frameAncestorsOf", () => {
  it("finds the directive or reports none", () => {
    expect(frameAncestorsOf("default-src 'self'; frame-ancestors 'self' https://x.y")).toEqual([
      "'self'",
      "https://x.y",
    ]);
    expect(frameAncestorsOf("default-src 'self'")).toBeNull();
  });
});

describe("decideEmbed", () => {
  it("lets frame-ancestors override X-Frame-Options", () => {
    expect(
      decideEmbed(
        {
          xFrameOptions: "SAMEORIGIN",
          contentSecurityPolicies: ["frame-ancestors 'self' https://app.uno4.work"],
        },
        APP,
        WORK,
      ).verdict,
    ).toBe("ok");
  });
  it("blocks Nextcloud's default headers", () => {
    expect(
      decideEmbed(
        {
          xFrameOptions: "SAMEORIGIN",
          contentSecurityPolicies: [
            "default-src 'self'; frame-ancestors 'self'; form-action 'self'",
          ],
        },
        APP,
        WORK,
      ).verdict,
    ).toBe("blocked");
  });
  it("requires every policy to allow", () => {
    expect(
      decideEmbed(
        {
          xFrameOptions: null,
          contentSecurityPolicies: [
            "frame-ancestors https://app.uno4.work",
            "frame-ancestors 'self'",
          ],
        },
        APP,
        WORK,
      ).verdict,
    ).toBe("blocked");
  });
  it("reads X-Frame-Options when there is no frame-ancestors", () => {
    expect(
      decideEmbed({ xFrameOptions: "DENY", contentSecurityPolicies: [] }, APP, WORK).verdict,
    ).toBe("blocked");
    expect(
      decideEmbed({ xFrameOptions: "sameorigin", contentSecurityPolicies: [] }, APP, APP).verdict,
    ).toBe("ok");
    expect(
      decideEmbed({ xFrameOptions: null, contentSecurityPolicies: [] }, APP, WORK).verdict,
    ).toBe("ok");
  });
  it("is unknown for non-web addresses", () => {
    expect(
      decideEmbed({ xFrameOptions: null, contentSecurityPolicies: [] }, "ftp://x", WORK).verdict,
    ).toBe("unknown");
  });
});

describe("checkEmbed", () => {
  it("decides on the final address after redirects", async () => {
    const fetchImpl = (async () => {
      const response = new Response("", {
        headers: { "x-frame-options": "SAMEORIGIN" },
      });
      Object.defineProperty(response, "url", { value: "https://nextcloud-box.app.uno4.dev/login" });
      return response;
    }) as unknown as typeof fetch;
    expect(
      (
        await checkEmbed(
          { url: "https://nextcloud-box.app.uno4.dev/", embedderOrigin: WORK },
          fetchImpl,
        )
      ).verdict,
    ).toBe("blocked");
  });
  it("is unknown when the app doesn't answer", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await checkEmbed({ url: APP, embedderOrigin: WORK }, fetchImpl)).verdict).toBe(
      "unknown",
    );
  });
});
