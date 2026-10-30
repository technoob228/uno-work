import { describe, expect, it } from "vitest";

import { settingsOwnerLine, settingsPageScope } from "./settingsPageScope";

describe("settingsPageScope", () => {
  it("lets the person pick on pages with per-project settings", () => {
    expect(settingsPageScope("/settings/ai")).toEqual({ kind: "scoped" });
    expect(settingsPageScope("/settings/environment/env-1/general")).toEqual({ kind: "scoped" });
    expect(settingsPageScope("/settings/environment/env-1/projects")).toEqual({ kind: "scoped" });
  });

  it("offers only a computer where settings exist per computer", () => {
    expect(settingsPageScope("/settings/environment/env-1/providers")).toEqual({
      kind: "computer",
    });
    expect(settingsPageScope("/settings/environment/env-1/diagnostics")).toEqual({
      kind: "computer",
    });
  });

  it("names the owner where nothing can be picked", () => {
    expect(settingsPageScope("/settings/account")).toEqual({ kind: "owned", owner: "account" });
    expect(settingsPageScope("/settings/app/general")).toEqual({ kind: "owned", owner: "device" });
  });

  it("stays out of pages it knows nothing about", () => {
    expect(settingsPageScope("/settings/workspace")).toBeNull();
  });

  it("says plainly who owns a page", () => {
    expect(settingsOwnerLine("this-computer", "Mainbook")).toBe("These belong to Mainbook.");
  });
});
