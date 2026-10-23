import { describe, expect, it } from "vitest";

import {
  editDuties,
  parseAddresses,
  parseDailyLimit,
  WORKS_ON_LINE,
  worksOnOptions,
  worksOnWishLine,
} from "./assistantPage.logic";

describe("its duties as an edited list", () => {
  it("adds, edits, removes with an empty text, and drops repeats", () => {
    const one = editDuties([], null, "  Watch CI   on fishcode ");
    expect(one).toEqual(["Watch CI on fishcode"]);
    const two = editDuties(one, null, "Morning plan at 9");
    expect(editDuties(two, 0, "Watch CI on landing")).toEqual([
      "Watch CI on landing",
      "Morning plan at 9",
    ]);
    expect(editDuties(two, 1, "")).toEqual(["Watch CI on fishcode"]);
    expect(editDuties(two, null, "watch ci on FISHCODE")).toEqual(two);
    expect(
      editDuties(
        Array.from({ length: 12 }, (_, i) => `d${i}`),
        null,
        "one more",
      ),
    ).toHaveLength(12);
  });
});

describe("its mail fields", () => {
  it("reads addresses and the daily limit", () => {
    expect(parseAddresses("Ann@Example.com, bob@x.io; nope ann@example.com")).toEqual({
      addresses: ["ann@example.com", "bob@x.io"],
      invalid: ["nope"],
    });
    expect(parseDailyLimit("10", 50)).toBe(10);
    expect(parseDailyLimit("0", 50)).toBe(0);
    expect(parseDailyLimit("51", 50)).toBeNull();
    expect(parseDailyLimit("2.5", 50)).toBeNull();
  });
});

describe("where it works", () => {
  const machines = [
    { environmentId: "env-mac", label: "Misha's MacBook", kind: "computer", status: "online" },
    { environmentId: "env-work", label: "uno-work", kind: "uno_box", status: "online" },
    { environmentId: "env-nap", label: "uno-product", kind: "uno_box", status: "sleeping" },
    { environmentId: null, label: "new-box", kind: "uno_box", status: "unknown" },
  ];

  it("on a laptop: here stops when it sleeps; each cloud computer and its own computer", () => {
    const options = worksOnOptions({ isUno: false, hereEnvironmentId: "env-mac", machines });
    expect(options.map((option) => option.kind)).toEqual([
      "here",
      "cloud",
      "cloud",
      "cloud",
      "own",
    ]);
    expect(options[0]).toEqual({
      kind: "here",
      label: "Misha's MacBook",
      line: WORKS_ON_LINE.laptop,
    });
    expect(options[1]).toMatchObject({ environmentId: "env-work", blocked: null });
    expect(options[2]).toMatchObject({ blocked: "It's asleep — wake it first." });
    expect(options[3]).toMatchObject({ blocked: expect.stringContaining("Open it in Uno Work") });
  });

  it("on a cloud computer it is always on; Uno only stays", () => {
    const cloud = worksOnOptions({ isUno: false, hereEnvironmentId: "env-work", machines });
    expect(cloud[0]).toMatchObject({ label: "uno-work", line: WORKS_ON_LINE.cloudHere });
    expect(cloud.filter((option) => option.kind === "cloud")).toHaveLength(2);
    expect(worksOnOptions({ isUno: true, hereEnvironmentId: "env-work", machines })).toHaveLength(
      1,
    );
  });

  it("never lists the computer it is on as a cloud computer; cloud rows carry the console's name", () => {
    const options = worksOnOptions({
      isUno: false,
      hereEnvironmentId: "env-box",
      machines: [
        // Its own computer, twice: its connection and its box on the account (no connection).
        {
          environmentId: "env-box",
          boxId: 2617,
          boxName: "uno-work",
          label: "Mikhail's MacBook Air (2)",
          kind: "uno_box",
          status: "online",
        },
        {
          environmentId: null,
          boxId: 2617,
          boxName: "uno-work",
          label: "uno-work",
          kind: "uno_box",
          status: "online",
        },
        // Another computer with the same daemon label: kept, under the console's name.
        {
          environmentId: "env-other",
          boxId: 2618,
          boxName: "uno-product",
          label: "Mikhail's MacBook Air (2)",
          kind: "uno_box",
          status: "online",
        },
      ],
    });
    expect(options.map((option) => [option.kind, option.label])).toEqual([
      ["here", "Mikhail's MacBook Air (2)"],
      ["cloud", "uno-product"],
      ["own", "A computer of its own"],
    ]);
  });

  it("says what the person asked for in the setup", () => {
    expect(worksOnWishLine("cloud")).toContain("cloud computers");
    expect(worksOnWishLine("here")).toBeNull();
    expect(worksOnWishLine(null)).toBeNull();
  });
});
