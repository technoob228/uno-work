import { describe, expect, it } from "vitest";

import {
  allowlistFromScopeForm,
  describeScope,
  pickableProjects,
  scopeFormFromAllowlist,
} from "./assistantScope.logic";

describe("assistant scope form", () => {
  it("reads All projects by default and round-trips a list without the assistant's own workspace", () => {
    expect(scopeFormFromAllowlist("all").mode).toBe("all");
    expect(scopeFormFromAllowlist(null).mode).toBe("all");
    const form = scopeFormFromAllowlist(["assistant-home", "p2", "p1"]);
    expect(form.mode).toBe("only");
    expect([...form.selected]).toEqual(["p2", "p1"]);
    expect(allowlistFromScopeForm(form)).toEqual(["p1", "p2"]);
    expect(allowlistFromScopeForm({ mode: "all", selected: new Set(["p1"]) })).toBe("all");
  });

  it("lists projects without assistant workspaces, by name", () => {
    expect(
      pickableProjects([
        { id: "p2", title: "Site" },
        { id: "assistant-home", title: "Assistant" },
        { id: "p1", title: "Home folder" },
      ]).map((project) => project.id),
    ).toEqual(["p1", "p2"]);
  });

  it("describes the choice", () => {
    expect(describeScope({ mode: "all", selected: new Set() })).toContain("every project");
    expect(describeScope({ mode: "only", selected: new Set() })).toContain("only its own");
    expect(describeScope({ mode: "only", selected: new Set(["a", "b"]) })).toContain("2 projects");
  });
});
