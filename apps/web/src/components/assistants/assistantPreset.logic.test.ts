import type { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESET_FORM,
  effectiveLevel,
  levelCeiling,
  modeOfForm,
  presetAccessFromForm,
  presetFormFromToken,
  projectsChoice,
  projectsLine,
  samePresetForm,
  withMode,
} from "./assistantPreset.logic";

const p = (id: string) => id as ProjectId;

describe("mode picker form", () => {
  it("reads the token: no token = Full on every project", () => {
    expect(presetFormFromToken(null)).toEqual(DEFAULT_PRESET_FORM);
    const helper = presetFormFromToken({
      scopes: ["threads:read", "threads:write"],
      projectAllowlist: [p("assistant-scout"), p("site")],
    });
    expect(helper.preset).toBe("helper");
    // Its own workspace isn't listed (always in, never removable).
    expect([...helper.scope.selected]).toEqual(["site"]);
    expect(presetFormFromToken({ scopes: ["threads:read"], projectAllowlist: "all" }).preset).toBe(
      "observer",
    );
  });

  it("shows two modes: Full is 'Autonomous', Helper and Observer 'Cautious'", () => {
    expect(modeOfForm(DEFAULT_PRESET_FORM)).toBe("itself");
    expect(modeOfForm({ ...DEFAULT_PRESET_FORM, preset: "helper" })).toBe("asks-first");
    expect(modeOfForm({ ...DEFAULT_PRESET_FORM, preset: "observer" })).toBe("asks-first");
  });

  it("'Cautious' saves Helper on every project; an old Observer stays one", () => {
    expect(presetAccessFromForm(withMode(DEFAULT_PRESET_FORM, "asks-first"))).toEqual({
      preset: "helper",
      projects: "all",
    });
    const observer = { ...DEFAULT_PRESET_FORM, preset: "observer" as const };
    expect(withMode(observer, "asks-first").preset).toBe("observer");
    expect(withMode(observer, "itself").preset).toBe("full");
    const picked = {
      preset: "helper" as const,
      scope: { mode: "only" as const, selected: new Set(["b", "a"]) },
    };
    expect(presetAccessFromForm(withMode(picked, "itself"))).toEqual({
      preset: "full",
      projects: ["a", "b"],
    });
  });

  it("knows when nothing changed", () => {
    const a = {
      preset: "helper" as const,
      scope: { mode: "only" as const, selected: new Set(["x"]) },
    };
    const b = {
      preset: "helper" as const,
      scope: { mode: "only" as const, selected: new Set(["x"]) },
    };
    expect(samePresetForm(a, b)).toBe(true);
    expect(samePresetForm(a, withMode(a, "itself"))).toBe(false);
    expect(samePresetForm(DEFAULT_PRESET_FORM, withMode(DEFAULT_PRESET_FORM, "asks-first"))).toBe(
      false,
    );
  });

  it("caps app levels for an old Observer only", () => {
    expect(levelCeiling("observer")).toBe("read");
    expect(levelCeiling("helper")).toBe("write");
    expect(effectiveLevel("write", "observer")).toBe("read");
    expect(effectiveLevel("write", "full")).toBe("write");
  });

  it("says where it works in plain words", () => {
    expect(projectsLine(DEFAULT_PRESET_FORM, "Scout")).toBe("Scout works in every project.");
    expect(
      projectsLine(
        { ...DEFAULT_PRESET_FORM, scope: { mode: "only", selected: new Set() } },
        "Scout",
      ),
    ).toContain("only its own chats");
  });
});

describe("only selected projects", () => {
  const all = { mode: "all" as const, selected: new Set<string>() };
  const some = { mode: "only" as const, selected: new Set(["site"]) };

  it("on this computer without a sandbox: sees everything, the limit needs its own computer", () => {
    expect(projectsChoice({ sandbox: false, ownComputer: false, scope: all })).toEqual({
      canPickSome: false,
      note: "Sees everything on this computer. Only selected projects needs its own computer.",
    });
  });

  it("with a sandbox or on its own computer the limit holds", () => {
    expect(projectsChoice({ sandbox: true, ownComputer: false, scope: all })).toEqual({
      canPickSome: true,
      note: null,
    });
    expect(projectsChoice({ sandbox: false, ownComputer: true, scope: some }).note).toBeNull();
  });

  it("an assistant already limited here keeps its list, with the honest line", () => {
    const choice = projectsChoice({ sandbox: false, ownComputer: false, scope: some });
    expect(choice.canPickSome).toBe(true);
    expect(choice.note).toContain("can't hold it to these projects");
  });
});
