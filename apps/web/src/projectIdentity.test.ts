import { describe, expect, it } from "vitest";

import { deriveProjectIdentity } from "./projectIdentity";

describe("deriveProjectIdentity", () => {
  it("takes the first letters of the first and last words", () => {
    expect(deriveProjectIdentity("uno work").monogram).toBe("UW");
    expect(deriveProjectIdentity("eu4-llm").monogram).toBe("E4");
    expect(deriveProjectIdentity("landing").monogram).toBe("LG");
    expect(deriveProjectIdentity("Иммиграция").monogram).toBe("ИЯ");
    expect(deriveProjectIdentity("  ").monogram).toBe("PR");
  });

  it("gives the same name the same color", () => {
    expect(deriveProjectIdentity("landing").color).toBe(deriveProjectIdentity("Landing").color);
  });
});
