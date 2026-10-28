import { describe, expect, it } from "vitest";

import { filterAppsBySearch, matchesAppSearch } from "./appsGridModel";

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
