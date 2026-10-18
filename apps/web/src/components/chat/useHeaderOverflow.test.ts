import { describe, expect, it } from "vitest";

import { pickFoldedHeaderItems } from "./useHeaderOverflow";

const items = [
  { id: "project", cost: 90, silent: true },
  { id: "continue", cost: 32 },
  { id: "diff", cost: 32 },
  { id: "terminal", cost: 32 },
];

describe("pickFoldedHeaderItems", () => {
  it("folds nothing while everything fits", () => {
    expect(pickFoldedHeaderItems({ available: 500, fixed: 300, items, moreCost: 32 })).toEqual([]);
  });

  it("lets the project's name go first, without the ⋯ menu", () => {
    // 300 + 186 = 486 > 450; without the name: 396.
    expect(pickFoldedHeaderItems({ available: 450, fixed: 300, items, moreCost: 32 })).toEqual([
      "project",
    ]);
  });

  it("counts the ⋯ button once a button folds", () => {
    // Without the name 396 > 380; without "continue" 364 + ⋯ 32 = 396 > 380;
    // without "diff" too: 364.
    expect(pickFoldedHeaderItems({ available: 380, fixed: 300, items, moreCost: 32 })).toEqual([
      "project",
      "continue",
      "diff",
    ]);
  });

  it("skips what renders nothing", () => {
    expect(
      pickFoldedHeaderItems({
        available: 340,
        fixed: 300,
        items: [
          { id: "continue", cost: 0 },
          { id: "terminal", cost: 32 },
          { id: "diff", cost: 32 },
        ],
        moreCost: 28,
      }),
    ).toEqual(["terminal", "diff"]);
  });
});
