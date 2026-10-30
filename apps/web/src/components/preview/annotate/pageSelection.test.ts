import { describe, expect, it } from "vitest";

import {
  buildPageToolsScript,
  PAGE_SELECTION_EXPRESSION,
  pageSelectionFrom,
} from "./pageToolsScript";

const rect = { x: 10, y: 20, w: 100, h: 16 };

describe("a selection the page reported", () => {
  it("passes when it is what it should be", () => {
    expect(pageSelectionFrom({ text: "Price", url: "https://a.test/", rect })).toEqual({
      text: "Price",
      url: "https://a.test/",
      rect,
    });
  });

  it("means nothing selected when empty or malformed, as a page can send anything", () => {
    expect(pageSelectionFrom({ text: "", url: "https://a.test/", rect })).toBeNull();
    expect(pageSelectionFrom(null)).toBeNull();
    expect(pageSelectionFrom({ text: 5, url: "x", rect })).toBeNull();
    expect(pageSelectionFrom({ text: "a", url: "x" })).toBeNull();
    expect(pageSelectionFrom({ text: "a", url: "x", rect: { ...rect, x: "1" } })).toBeNull();
  });

  it("keeps its size in check", () => {
    const long = pageSelectionFrom({ text: "x".repeat(50_000), url: "y".repeat(5_000), rect });
    expect(long?.text).toHaveLength(8_000);
    expect(long?.url).toHaveLength(2_000);
  });
});

describe("the page script", () => {
  it("is valid JavaScript with the selection reader in place", () => {
    const script = buildPageToolsScript("nonce:", "console");
    expect(script).not.toContain("__READ_SELECTION__");
    expect(() => new Function(`return ${script}`)).not.toThrow();
    expect(() => new Function(`return ${PAGE_SELECTION_EXPRESSION}`)).not.toThrow();
  });
});
