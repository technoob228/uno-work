import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vitest";

import { resolveShortcutCommand } from "../../keybindings";
import { sidebarToggleLabel, withSidebarToggle } from "./sidebarShortcut";

const cmdB = {
  key: "b",
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

describe("sidebar shortcut", () => {
  it("⌘B toggles the sidebar by default", () => {
    expect(
      resolveShortcutCommand(cmdB, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    ).toBe("sidebar.toggle");
    expect(sidebarToggleLabel(DEFAULT_RESOLVED_KEYBINDINGS)).toMatch(/B$/);
  });

  it("an older daemon without the rule still gets it", () => {
    const old = DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => rule.command !== "sidebar.toggle");
    const resolved = withSidebarToggle(old);
    expect(resolved.some((rule) => rule.command === "sidebar.toggle")).toBe(true);
    expect(
      resolveShortcutCommand(cmdB, resolved, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    ).toBe("sidebar.toggle");
  });

  it("not while a terminal has focus", () => {
    expect(
      resolveShortcutCommand(cmdB, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    ).toBeNull();
  });
});
