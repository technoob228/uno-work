import { describe, expect, it } from "vitest";

import { hardenLinks, sanitizeDocumentHtml } from "../../lib/safeHtml";

function parse(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("sanitizeDocumentHtml", () => {
  it("strips scripts, handlers and javascript: links from mammoth-like HTML", () => {
    const root = parse(
      sanitizeDocumentHtml(
        "<p>Hi<script>alert(1)</script></p>" +
          '<a href="javascript:alert(1)">bad</a>' +
          '<a href="https://uno4.dev">good</a>' +
          '<a href="#_Toc1">anchor</a>' +
          '<img src="x" onerror="alert(1)">' +
          '<img src="data:image/png;base64,AAAA">' +
          '<img src="data:image/svg+xml;base64,AAAA">' +
          '<iframe src="https://x"></iframe><form><input></form>' +
          '<p style="position:fixed" onclick="alert(1)">text</p>',
      ),
    );
    expect(root.querySelector("script, iframe, form, input")).toBeNull();
    expect(root.innerHTML).not.toMatch(/onerror|onclick|javascript:|style=/i);

    const links = [...root.querySelectorAll("a")];
    expect(links[0]!.hasAttribute("href")).toBe(false);
    expect(links[1]!.getAttribute("href")).toBe("https://uno4.dev");
    expect(links[1]!.getAttribute("target")).toBe("_blank");
    expect(links[1]!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[2]!.getAttribute("href")).toBe("#_Toc1");
    expect(links[2]!.hasAttribute("target")).toBe(false);

    const images = [...root.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(images).toEqual([null, "data:image/png;base64,AAAA", null]);
    expect(root.textContent).toContain("text");
  });
});

describe("hardenLinks", () => {
  it("rewrites links a library already rendered", () => {
    const root = parse(
      '<a href="javascript:alert(1)">a</a><a href="https://x.dev">b</a><a href="#p2">c</a>',
    );
    hardenLinks(root);
    const [bad, good, anchor] = [...root.querySelectorAll("a")];
    expect(bad!.hasAttribute("href")).toBe(false);
    expect(good!.getAttribute("target")).toBe("_blank");
    expect(good!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchor!.getAttribute("href")).toBe("#p2");
  });
});
