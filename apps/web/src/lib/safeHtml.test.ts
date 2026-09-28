import { describe, expect, it } from "vitest";

import { isSafeImageSrc, isSafeLinkHref } from "./safeHtml";

describe("isSafeLinkHref", () => {
  it("keeps web, mail, phone and in-page links", () => {
    expect(isSafeLinkHref("https://uno4.dev/x")).toBe(true);
    expect(isSafeLinkHref("http://example.com")).toBe(true);
    expect(isSafeLinkHref("mailto:hello@uno4.dev")).toBe(true);
    expect(isSafeLinkHref("tel:+100")).toBe(true);
    expect(isSafeLinkHref("#_Toc1")).toBe(true);
  });

  it("drops script, data, file and obfuscated schemes", () => {
    expect(isSafeLinkHref("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkHref("JavaScript:alert(1)")).toBe(false);
    expect(isSafeLinkHref(" java\tscript:alert(1)")).toBe(false);
    expect(isSafeLinkHref("\u0001javascript:alert(1)")).toBe(false);
    expect(isSafeLinkHref("vbscript:x")).toBe(false);
    expect(isSafeLinkHref("data:text/html,<script>1</script>")).toBe(false);
    expect(isSafeLinkHref("file:///etc/passwd")).toBe(false);
    expect(isSafeLinkHref("../secrets.txt")).toBe(false);
    expect(isSafeLinkHref("")).toBe(false);
  });
});

describe("isSafeImageSrc", () => {
  it("keeps raster data images and web images only", () => {
    expect(isSafeImageSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeImageSrc("https://x/y.png")).toBe(true);
    expect(isSafeImageSrc("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isSafeImageSrc("data:text/html;base64,AAAA")).toBe(false);
    expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
  });
});
