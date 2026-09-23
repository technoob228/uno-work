import { describe, expect, it } from "vitest";

import {
  addPin,
  findPin,
  linkTitle,
  normalizeLinkInput,
  pathTitle,
  removePin,
  renamePin,
} from "./pins";

describe("pins", () => {
  it("adds once, finds and removes", () => {
    const one = addPin([], { kind: "app", title: "Nextcloud", target: "https://nc.app.uno4.dev" });
    const two = addPin(one, { kind: "app", title: "Nextcloud", target: "https://nc.app.uno4.dev" });
    expect(two).toHaveLength(1);
    expect(findPin(two, "app", "https://nc.app.uno4.dev")?.title).toBe("Nextcloud");
    expect(findPin(two, "link", "https://nc.app.uno4.dev")).toBeNull();
    expect(removePin(two, two[0]!.id)).toEqual([]);
  });
  it("keeps the newest 50", () => {
    let pins = addPin([], { kind: "link", title: "0", target: "https://a0.com" });
    for (let i = 1; i < 60; i++) {
      pins = addPin(pins, { kind: "link", title: String(i), target: `https://a${i}.com` });
    }
    expect(pins).toHaveLength(50);
    expect(pins[0]!.title).toBe("10");
  });
  it("renames, ignoring blanks", () => {
    const pins = addPin([], { kind: "folder", title: "docs", target: "/home/u/docs" });
    expect(renamePin(pins, pins[0]!.id, "  Documents ")[0]!.title).toBe("Documents");
    expect(renamePin(pins, pins[0]!.id, "  ")[0]!.title).toBe("docs");
  });
});

describe("normalizeLinkInput", () => {
  it("adds https to bare domains and refuses other schemes", () => {
    expect(normalizeLinkInput("uno4.dev")).toBe("https://uno4.dev/");
    expect(normalizeLinkInput("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
    expect(normalizeLinkInput("javascript:alert(1)")).toBeNull();
    expect(normalizeLinkInput("hello")).toBeNull();
    expect(normalizeLinkInput("")).toBeNull();
  });
});

describe("titles", () => {
  it("derives readable titles", () => {
    expect(linkTitle("https://www.figma.com/file/x")).toBe("figma.com");
    expect(pathTitle("/home/unowork/Documents/")).toBe("Documents");
    expect(pathTitle("/home/unowork/Q3.docx")).toBe("Q3.docx");
  });
});
