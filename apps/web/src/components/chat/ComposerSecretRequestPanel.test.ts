import { describe, expect, it } from "vitest";

import { homeRelativePath, secretTargetPath } from "./ComposerSecretRequestPanel";

describe("secretTargetPath", () => {
  it("joins the request folder and env file", () => {
    expect(secretTargetPath("/home/me/projects/app", ".env")).toBe("/home/me/projects/app/.env");
    expect(secretTargetPath("/home/me/projects/app/", ".env.local")).toBe(
      "/home/me/projects/app/.env.local",
    );
    expect(secretTargetPath("", ".env")).toBe(".env");
  });
});

describe("homeRelativePath", () => {
  it("shows the home folder as ~", () => {
    expect(homeRelativePath("/home/unowork/projects/bot/.env")).toBe("~/projects/bot/.env");
    expect(homeRelativePath("/Users/anna/projects/app/.env")).toBe("~/projects/app/.env");
    expect(homeRelativePath("/srv/app/.env")).toBe("/srv/app/.env");
  });
});
