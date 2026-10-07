import { describe, expect, it } from "vitest";

import { chatLinkTarget, toExternalHttpUrl } from "./externalLinks";

describe("toExternalHttpUrl", () => {
  it("keeps http(s) links", () => {
    expect(toExternalHttpUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(toExternalHttpUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
  });
  it("refuses other schemes and relative paths", () => {
    for (const href of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "smb://host/x",
      "vscode://x",
      "./notes.md",
      "",
      undefined,
    ]) {
      expect(toExternalHttpUrl(href)).toBeNull();
    }
  });
});

describe("chatLinkTarget", () => {
  it("the console always opens in a new tab", () => {
    expect(chatLinkTarget("https://console.uno.place/sites/yoga?tab=forms")).toBe("console");
    expect(chatLinkTarget("https://console.uno4.dev/billing")).toBe("console");
  });
  it("own sites, Work apps and local previews open in the right panel", () => {
    for (const href of [
      "https://sun-salute-yoga.uno4.me/",
      "https://abc123.uno4.work/app/notes",
      "http://localhost:3000/",
      "http://127.0.0.1:5173",
    ]) {
      expect(chatLinkTarget(href)).toBe("own");
    }
  });
  it("everything else is external; non-http is nothing", () => {
    expect(chatLinkTarget("https://github.com/x/y")).toBe("external");
    expect(chatLinkTarget("https://evil-uno4.me.example.com/")).toBe("external");
    expect(chatLinkTarget("javascript:alert(1)")).toBeNull();
    expect(chatLinkTarget(undefined)).toBeNull();
  });
});
