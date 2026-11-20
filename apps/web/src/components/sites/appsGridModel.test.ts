import { describe, expect, it } from "vitest";

import { filterAppsBySearch, firstToOpen, matchesAppSearch } from "./appsGridModel";

describe("matchesAppSearch", () => {
  it("keeps everything for an empty query", () => {
    expect(matchesAppSearch({ name: "Ollama" }, "")).toBe(true);
    expect(matchesAppSearch({ name: "Ollama" }, "   ")).toBe(true);
  });

  it("matches the start of any word, any case", () => {
    expect(matchesAppSearch({ name: "Рассылка: кто открыл и оплатил" }, "опла")).toBe(true);
    expect(matchesAppSearch({ name: "OKR статус" }, "okr")).toBe(true);
    expect(matchesAppSearch({ name: "OKR статус" }, "тус")).toBe(false);
  });

  it("looks at the product name and the caption too", () => {
    expect(matchesAppSearch({ name: "Files & documents", product: "Nextcloud" }, "next")).toBe(
      true,
    );
    expect(matchesAppSearch({ name: "node", caption: "Program · 4704" }, "4704")).toBe(true);
  });

  it("ignores punctuation and the case of the query", () => {
    expect(matchesAppSearch({ name: "Files & documents" }, "  FILES, doc ")).toBe(true);
    expect(
      matchesAppSearch({ name: "Uno Notetaker", caption: "Notes from your calls" }, "calls"),
    ).toBe(true);
    expect(matchesAppSearch({ name: "Terminal" }, "&")).toBe(true);
  });

  it("does not match the middle of a word", () => {
    expect(matchesAppSearch({ name: "Notetaker" }, "taker")).toBe(false);
  });

  it("needs every word of the query", () => {
    expect(matchesAppSearch({ name: "Uno Work" }, "uno wo")).toBe(true);
    expect(matchesAppSearch({ name: "Uno Work" }, "uno drive")).toBe(false);
  });
});

describe("filterAppsBySearch", () => {
  it("keeps the order", () => {
    const apps = [{ name: "Uno Drive" }, { name: "Terminal" }, { name: "Uno Work" }];
    expect(filterAppsBySearch(apps, "uno").map((app) => app.name)).toEqual([
      "Uno Drive",
      "Uno Work",
    ]);
  });
});

describe("firstToOpen", () => {
  const disabled = (tile: { name: string; off?: boolean }) => tile.off === true;

  it("opens a built-in first, skipping a busy one", () => {
    const builtIns = [
      { name: "Terminal", disabled: true },
      { name: "App Store", disabled: false },
    ];
    expect(firstToOpen(builtIns, [{ name: "Notes" }], disabled)).toEqual({
      builtIn: builtIns[1],
    });
  });

  it("then the first app a click can do something with", () => {
    const tiles = [{ name: "Installing", off: true }, { name: "Notes" }];
    expect(firstToOpen([], tiles, disabled)).toEqual({ tile: tiles[1] });
  });

  it("is nothing when every match is busy or nothing matched", () => {
    expect(firstToOpen([], [{ name: "Installing", off: true }], disabled)).toBeNull();
    expect(firstToOpen([], [], disabled)).toBeNull();
  });
});
