import { describe, expect, it } from "vitest";

import { computerOfferCopy } from "./computerOffer";

describe("computerOfferCopy", () => {
  it("Small: says Uno builds on Plus, offers the person's own agent", () => {
    const copy = computerOfferCopy("small");
    expect(copy.title).toBe("Uno builds this on Plus");
    expect(copy.upgradeLabel).toBe("Upgrade to Plus");
    expect(copy.ownAgent).toBe(true);
    expect(copy.note).toMatch(/Uno doesn't build there/);
  });

  it("free and unknown: the trial card as before", () => {
    for (const standing of ["free", null] as const) {
      const copy = computerOfferCopy(standing);
      expect(copy.title).toBe("This needs your own computer");
      expect(copy.ownAgent).toBe(false);
      expect(copy.note).toBeNull();
    }
  });
});
