import { describe, expect, it } from "vitest";

import { parseWorkIntent, uploadedProjectPrompt } from "./workIntent";

describe("workIntent", () => {
  it("knows upload and nothing else", () => {
    expect(parseWorkIntent("upload")).toBe("upload");
    expect(parseWorkIntent("rm")).toBeNull();
    expect(parseWorkIntent(null)).toBeNull();
    expect(parseWorkIntent(undefined)).toBeNull();
  });

  it("asks Uno to offer publishing, not to publish", () => {
    const prompt = uploadedProjectPrompt("my-site", "/home/uno/projects/my-site");
    expect(prompt).toContain("/home/uno/projects/my-site");
    expect(prompt).toContain("offer to put it online");
    expect(prompt).toContain("Ask me before you publish");
  });
});
