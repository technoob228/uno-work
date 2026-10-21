import type { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRESET_FORM,
  effectiveLevel,
  levelCeiling,
  presetAccessFromForm,
  presetFormFromToken,
  projectsLine,
  samePresetForm,
  withPreset,
} from "./assistantPreset.logic";

const p = (id: string) => id as ProjectId;

describe("preset picker form", () => {
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

  it("Helper and Observer always save the ticked projects, never 'all'", () => {
    const observer = withPreset(DEFAULT_PRESET_FORM, "observer");
    expect(presetAccessFromForm(observer)).toEqual({ preset: "observer", projects: [] });
    const picked = { ...observer, scope: { mode: "only" as const, selected: new Set(["b", "a"]) } };
    expect(presetAccessFromForm(picked)).toEqual({ preset: "observer", projects: ["a", "b"] });
    expect(presetAccessFromForm(withPreset(picked, "full"))).toEqual({
      preset: "full",
      projects: ["a", "b"],
    });
    expect(presetAccessFromForm(DEFAULT_PRESET_FORM)).toEqual({ preset: "full", projects: "all" });
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
    expect(samePresetForm(a, withPreset(a, "observer"))).toBe(false);
    expect(samePresetForm(DEFAULT_PRESET_FORM, withPreset(DEFAULT_PRESET_FORM, "helper"))).toBe(
      false,
    );
  });

  it("caps app levels for an Observer only", () => {
    expect(levelCeiling("observer")).toBe("read");
    expect(levelCeiling("helper")).toBe("write");
    expect(effectiveLevel("write", "observer")).toBe("read");
    expect(effectiveLevel("write", "full")).toBe("write");
  });

  it("says where it works in plain words", () => {
    expect(projectsLine(DEFAULT_PRESET_FORM, "Scout")).toBe("Scout works in every project.");
    expect(projectsLine(withPreset(DEFAULT_PRESET_FORM, "helper"), "Scout")).toContain(
      "only its own chats",
    );
  });
});
