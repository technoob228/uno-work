import { describe, expect, it } from "vitest";

import { toExternalHttpUrl } from "./externalLinks";

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
