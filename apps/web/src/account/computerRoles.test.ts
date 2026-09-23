import { describe, expect, it } from "vitest";

import { computerRole, parseRoleComment, withRole } from "./computerRoles";

describe("computer roles", () => {
  it("reads the role tag at the start of the comment", () => {
    expect(parseRoleComment("[production] shop backend")).toEqual({
      role: "production",
      note: "shop backend",
    });
    expect(parseRoleComment("  [Staging]")).toEqual({ role: "staging", note: "" });
    expect(parseRoleComment("just a note")).toEqual({ role: null, note: "just a note" });
    expect(parseRoleComment(null)).toEqual({ role: null, note: "" });
    expect(parseRoleComment("[unknown] x")).toEqual({ role: null, note: "[unknown] x" });
  });

  it("keeps the person's note when the role changes", () => {
    expect(withRole("[server] my vpn", "production")).toBe("[production] my vpn");
    expect(withRole("my vpn", "sandbox")).toBe("[sandbox] my vpn");
    expect(withRole("", "server")).toBe("[server]");
    expect(withRole(null, "staging")).toBe("[staging]");
  });

  it("an Uno Work computer is always the workspace; no tag reads as a server", () => {
    expect(computerRole({ workMachine: true, comment: "[production]" })).toBe("workspace");
    expect(computerRole({ workMachine: false, comment: "" })).toBe("server");
    expect(computerRole({ workMachine: false, comment: "[workspace]" })).toBe("server");
    expect(computerRole({ workMachine: false, comment: "[staging] try" })).toBe("staging");
  });
});
