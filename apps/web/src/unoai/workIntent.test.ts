import { describe, expect, it } from "vitest";

import { parseWorkIntent, uploadedProjectPrompt } from "./workIntent";

describe("workIntent", () => {
  it("knows upload and nothing else", () => {
    expect(parseWorkIntent("upload")).toBe("upload");
    expect(parseWorkIntent("rm")).toBeNull();
    expect(parseWorkIntent(null)).toBeNull();
    expect(parseWorkIntent(undefined)).toBeNull();
  });

  it("has Uno publish a plain site at once and never asks first", () => {
    const prompt = uploadedProjectPrompt("my-site", "/home/uno/projects/my-site");
    expect(prompt).toContain("/home/uno/projects/my-site");
    expect(prompt).toContain("publish it right away");
    expect(prompt).toContain("don't ask first");
    expect(prompt).not.toMatch(/ask me before/i);
    // A backend is not a site: it is offered as an app, not published.
    expect(prompt).toContain("don't publish it");
  });
});
