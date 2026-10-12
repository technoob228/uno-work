import { describe, expect, it } from "vitest";

import {
  blockOfTypedPrefix,
  documentShortcutOf,
  normalizeLinkAddress,
} from "./markdownDocumentTools";

const key = (over: Partial<Parameters<typeof documentShortcutOf>[0]>) =>
  documentShortcutOf({
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });

describe("blockOfTypedPrefix", () => {
  it("markdown typed at the start of a line names its block", () => {
    expect(blockOfTypedPrefix("#")).toBe("h1");
    expect(blockOfTypedPrefix("##")).toBe("h2");
    expect(blockOfTypedPrefix("###")).toBe("h3");
    expect(blockOfTypedPrefix("-")).toBe("bullet");
    expect(blockOfTypedPrefix("*")).toBe("bullet");
    expect(blockOfTypedPrefix("1.")).toBe("numbered");
    expect(blockOfTypedPrefix(">")).toBe("quote");
    expect(blockOfTypedPrefix("[]")).toBe("todo");
    expect(blockOfTypedPrefix("[ ]")).toBe("todo");
  });

  it("anything else is just text", () => {
    expect(blockOfTypedPrefix("####")).toBeNull();
    expect(blockOfTypedPrefix("2.")).toBeNull();
    expect(blockOfTypedPrefix("a")).toBeNull();
    expect(blockOfTypedPrefix("")).toBeNull();
  });
});

describe("normalizeLinkAddress", () => {
  it("a bare site gets its https", () => {
    expect(normalizeLinkAddress(" example.com/page ")).toBe("https://example.com/page");
  });

  it("an address with a scheme, an anchor or a path stays as typed", () => {
    expect(normalizeLinkAddress("http://a.b")).toBe("http://a.b");
    expect(normalizeLinkAddress("mailto:me@a.b")).toBe("mailto:me@a.b");
    expect(normalizeLinkAddress("#part")).toBe("#part");
    expect(normalizeLinkAddress("./notes.md")).toBe("./notes.md");
    expect(normalizeLinkAddress("")).toBe("");
  });
});

describe("documentShortcutOf", () => {
  it("sizes, lists and marks from the keyboard", () => {
    expect(key({ metaKey: true, altKey: true, code: "Digit2" })).toEqual({
      type: "block",
      kind: "h2",
    });
    expect(key({ ctrlKey: true, altKey: true, code: "Digit0" })).toEqual({
      type: "block",
      kind: "text",
    });
    expect(key({ metaKey: true, shiftKey: true, code: "Digit8" })).toEqual({
      type: "block",
      kind: "bullet",
    });
    expect(key({ metaKey: true, shiftKey: true, code: "KeyX" })).toEqual({
      type: "inline",
      kind: "strike",
    });
    expect(key({ metaKey: true, key: "e" })).toEqual({ type: "inline", kind: "code" });
    expect(key({ metaKey: true, key: "k" })).toEqual({ type: "link" });
  });

  it("Tab moves a list item; bold, italic and save stay the browser's and the editor's", () => {
    expect(key({ key: "Tab" })).toEqual({ type: "indent" });
    expect(key({ key: "Tab", shiftKey: true })).toEqual({ type: "outdent" });
    expect(key({ metaKey: true, key: "b" })).toBeNull();
    expect(key({ metaKey: true, key: "s" })).toBeNull();
    expect(key({ key: "a" })).toBeNull();
  });
});
