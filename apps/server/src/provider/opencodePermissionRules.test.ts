import { describe, expect, it } from "vitest";

import { buildOpenCodePermissionRules } from "./opencodeRuntime.ts";

/** OpenCode applies the last matching rule. */
function decide(mode: Parameters<typeof buildOpenCodePermissionRules>[0], permission: string) {
  const rules = buildOpenCodePermissionRules(mode);
  const matches = (pattern: string) =>
    pattern === "*" ||
    pattern === permission ||
    (pattern.endsWith("*") && permission.startsWith(pattern.slice(0, -1)));
  return rules.findLast((rule) => matches(rule.permission))?.action;
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

  it("never asks for uno-work tools: the daemon asks the person itself", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
      expect(decide(mode, "uno-work_app_show_on_internet")).toBe("allow");
    }
    expect(decide("approval-required", "other-mcp_tool")).toBe("ask");
  });
});
