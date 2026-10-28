import { describe, expect, it } from "vitest";

import {
  homeRelativePath,
  secretRequestStatusLine,
  secretTargetPath,
} from "./ComposerSecretRequestPanel";

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

describe("secretRequestStatusLine (P15, 28.10)", () => {
  it("after the agent's turn the card says the key is still wanted and what saving does", () => {
    const line = secretRequestStatusLine(false);
    expect(line).toMatch(/^Still needed/);
    expect(line).toContain("gets a message in this chat");
  });

  it("while the agent works it says Uno picks it up", () => {
    expect(secretRequestStatusLine(true)).toBe("Uno picks it up as soon as you save it.");
  });
});
