import { describe, expect, it } from "vitest";

import { planFileActions, sharedCopyKey } from "./fileShare.logic";

describe("planFileActions", () => {
  it("desktop app, file on the laptop: menu, share through a cloud copy", () => {
    expect(planFileActions({ desktop: true, onThisLaptop: true })).toEqual({
      menu: true,
      share: "cloud-copy",
    });
  });

  it("desktop app, file on a cloud computer: menu, the computer makes the link", () => {
    expect(planFileActions({ desktop: true, onThisLaptop: false })).toEqual({
      menu: true,
      share: "computer-link",
    });
  });

  it("Work on a cloud computer: ↗ is Share, the computer makes the link", () => {
    expect(planFileActions({ desktop: false, onThisLaptop: false })).toEqual({
      menu: false,
      share: "computer-link",
    });
  });
});

describe("sharedCopyKey", () => {
  it("puts copies into Shared/", () => {
    expect(sharedCopyKey("pricing.md")).toBe("Shared/pricing.md");
  });
});
