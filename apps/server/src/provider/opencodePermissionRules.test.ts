import { describe, expect, it } from "vitest";

import { buildOpenCodePermissionRules } from "./opencodeRuntime.ts";

/** OpenCode applies the last matching rule. */
function decide(mode: Parameters<typeof buildOpenCodePermissionRules>[0], permission: string) {
  const rules = buildOpenCodePermissionRules(mode);
  return rules.findLast((rule) => rule.permission === permission || rule.permission === "*")
    ?.action;
}

describe("buildOpenCodePermissionRules", () => {
  it("full access allows everything", () => {
    expect(decide("full-access", "bash")).toBe("allow");
  });

  it("reading the project never asks; outside the project always does", () => {
    for (const mode of ["approval-required", "auto-accept-edits"] as const) {
      expect(decide(mode, "read")).toBe("allow");
      expect(decide(mode, "list")).toBe("allow");
      expect(decide(mode, "external_directory")).toBe("ask");
      expect(decide(mode, "bash")).toBe("ask");
      expect(decide(mode, "webfetch")).toBe("ask");
    }
  });

  it("only 'Edit files freely' edits without asking", () => {
    expect(decide("auto-accept-edits", "edit")).toBe("allow");
    expect(decide("approval-required", "edit")).toBe("ask");
  });
});
