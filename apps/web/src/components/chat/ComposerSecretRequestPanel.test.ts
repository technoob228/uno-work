import { describe, expect, it } from "vitest";

import { secretTargetPath } from "./ComposerSecretRequestPanel";

describe("secretTargetPath", () => {
  it("joins the request folder and env file", () => {
    expect(secretTargetPath("/home/me/projects/app", ".env")).toBe("/home/me/projects/app/.env");
    expect(secretTargetPath("/home/me/projects/app/", ".env.local")).toBe(
      "/home/me/projects/app/.env.local",
    );
    expect(secretTargetPath("", ".env")).toBe(".env");
  });
});
