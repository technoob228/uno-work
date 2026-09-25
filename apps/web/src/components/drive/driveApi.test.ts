import { describe, expect, it } from "vitest";

import { driveFolderOf, parseDriveRouteSearch } from "./driveApi";

describe("Uno Drive route", () => {
  it("keeps only known tabs and safe folders", () => {
    expect(parseDriveRouteSearch({})).toEqual({});
    expect(parseDriveRouteSearch({ tab: "telegram" })).toEqual({ tab: "telegram" });
    expect(parseDriveRouteSearch({ tab: "files" })).toEqual({});
    expect(parseDriveRouteSearch({ tab: "admin" })).toEqual({});
    expect(parseDriveRouteSearch({ prefix: "Telegram/2026-09/" })).toEqual({
      prefix: "Telegram/2026-09/",
    });
    for (const bad of ["../x/", "/abs/", "no-slash", 5]) {
      expect(parseDriveRouteSearch({ prefix: bad })).toEqual({});
    }
  });

  it("finds a file's folder", () => {
    expect(driveFolderOf("Telegram/2026-09/a.pdf")).toBe("Telegram/2026-09/");
    expect(driveFolderOf("a.pdf")).toBe("");
  });
});
