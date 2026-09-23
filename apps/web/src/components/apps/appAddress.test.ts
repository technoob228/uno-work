import { describe, expect, it } from "vitest";

import { appHost, belongsToComputer, isCrossSite, parseAppUrl } from "./appAddress";

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
  it("tells cross-site framing apart", () => {
    expect(isCrossSite("https://nc-box.app.uno4.dev", "app.uno4.work")).toBe(true);
    expect(isCrossSite("https://nc-box.app.uno4.dev", "box-me.app.uno4.dev")).toBe(false);
    expect(appHost("https://nc-box.app.uno4.dev/a")).toBe("nc-box.app.uno4.dev");
  });
});
