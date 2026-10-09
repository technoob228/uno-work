import { describe, expect, it } from "vitest";

import { appHost, belongsToComputer, parseAppUrl } from "./appAddress";

describe("app address rules", () => {
  it("parses only web addresses", () => {
    expect(parseAppUrl("https://nc-box.app.uno4.dev/apps/files")).toBe(
      "https://nc-box.app.uno4.dev/apps/files",
    );
    expect(parseAppUrl("javascript:alert(1)")).toBeNull();
    expect(parseAppUrl(42)).toBeNull();
  });
  it("frames only the computer's own apps, by origin", () => {
    const known = ["https://nc-box.app.uno4.dev", null, "http://localhost:3000/"];
    expect(belongsToComputer("https://nc-box.app.uno4.dev/login?x=1", known)).toBe(true);
    expect(belongsToComputer("http://localhost:3000/x", known)).toBe(true);
    expect(belongsToComputer("https://evil.example/nc-box.app.uno4.dev", known)).toBe(false);
    expect(belongsToComputer("https://nc-box.app.uno4.dev.evil.example", known)).toBe(false);
  });
  it("an app through Uno Work's own address matches by its path, never Work's own pages", () => {
    const known = ["https://box.uno4.work/_apps/notes/tok1/"];
    expect(belongsToComputer("https://box.uno4.work/_apps/notes/tok2/list", known)).toBe(true);
    expect(belongsToComputer("https://box.uno4.work/_apps/other/tok1/", known)).toBe(false);
    expect(belongsToComputer("https://box.uno4.work/files", known)).toBe(false);
    expect(belongsToComputer("https://box.uno4.work/", known)).toBe(false);
  });
  it("shows the host of an app address", () => {
    expect(appHost("https://nc-box.app.uno4.dev/a")).toBe("nc-box.app.uno4.dev");
  });
});
