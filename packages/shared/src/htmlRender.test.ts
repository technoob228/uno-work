import { describe, expect, it } from "vite-plus/test";

import {
  capThreadActivities,
  HTML_RENDER_ACTIVITY_KIND,
  HTML_RENDER_CSP,
  HTML_RENDER_SANDBOX,
  htmlRenderFrameDocument,
  htmlRenderTheme,
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
  readHtmlRenderReference,
  withHtmlRenderTheme,
} from "./htmlRender.ts";
import { UNO_LIGHT_THEME_COLORS } from "./themePalettes.ts";

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "iframe", "plaintext"])("keeps the bootstrap outside %s content", (tag) => {
    const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderImageRequest", () => {
  it("accepts http(s) and inline image URLs in an open-image notification", () => {
    const image = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/open-image",
      params,
    });
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({
      src: "data:image/png;base64,AA",
      name: "Chart",
    });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      src: "https://example.com/a.png",
      name: "Image",
    });
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });
});

describe("htmlRenderFrameDocument", () => {
  const page = `<p title="a&b">x</p><script>top.location="https://evil.test"</script>`;

  it("sets the policy before the page and keeps the page inside a sandboxed srcdoc", () => {
    const doc = htmlRenderFrameDocument(page);
    expect(doc.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
      doc.indexOf("<iframe"),
    );
    expect(doc).toContain(`sandbox="${HTML_RENDER_SANDBOX}"`);
    expect(doc).not.toContain("allow-same-origin");
    expect(doc).not.toContain("<script>top.location");
    expect(doc).toContain('title=&quot;a&amp;b&quot;');
  });

  it("can't be closed from inside the attribute", () => {
    const doc = htmlRenderFrameDocument(`"></iframe><script>alert(1)</script>`);
    expect(doc).toContain("&quot;></iframe>");
    expect(doc.match(/<iframe/g)).toHaveLength(1);
  });

  it("opens no network beyond the listed public libraries", () => {
    expect(HTML_RENDER_CSP).toContain("default-src 'none'");
    expect(HTML_RENDER_CSP).toContain("frame-src 'none'");
    expect(HTML_RENDER_CSP).toContain("form-action 'none'");
    expect(HTML_RENDER_CSP).not.toMatch(/\bhttps:(?!\/\/)/);
    expect(HTML_RENDER_CSP).not.toContain("'self'");
    expect(HTML_RENDER_CSP).not.toContain("*");
    expect(HTML_RENDER_CSP).not.toMatch(/img-src[^;]*fonts/);
  });
});

describe("withHtmlRenderTheme", () => {
  it("swaps the default theme for the reader's", () => {
    const stored = injectHtmlRenderBootstrap("<p>x</p>");
    const themed = withHtmlRenderTheme(
      stored,
      htmlRenderTheme(UNO_LIGHT_THEME_COLORS, "light"),
    );
    expect(themed).toContain(":root{color-scheme:light;");
    expect(themed).not.toContain("prefers-color-scheme");
    expect(themed.endsWith("<p>x</p>")).toBe(true);
  });

  it("leaves a page without the bootstrap alone", () => {
    expect(withHtmlRenderTheme("<p>x</p>", htmlRenderTheme(UNO_LIGHT_THEME_COLORS, "light"))).toBe(
      "<p>x</p>",
    );
  });
});

describe("readHtmlRenderReference", () => {
  const reference = { attachmentId: "t-1", path: "/state/attachments/t-1.html", title: "C", height: 420 };

  it("reads a reference and refuses a path that isn't the page's own file", () => {
    expect(readHtmlRenderReference(reference)).toEqual(reference);
    expect(readHtmlRenderReference({ ...reference, path: "/home/me/.env" })).toBeUndefined();
    expect(readHtmlRenderReference({ ...reference, path: 7 })).toBeUndefined();
  });
});

describe("capThreadActivities", () => {
  it("keeps the newest and every page", () => {
    const list = [
      { id: "page", kind: HTML_RENDER_ACTIVITY_KIND },
      { id: "old", kind: "tool.completed" },
      { id: "a", kind: "tool.completed" },
      { id: "b", kind: "tool.completed" },
    ];
    expect(capThreadActivities(list, 2).map((entry) => entry.id)).toEqual(["page", "a", "b"]);
    expect(capThreadActivities(list, 10)).toHaveLength(4);
  });
});
