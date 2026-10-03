import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vitest";

import { resolveShortcutCommand } from "../../keybindings";
import { isMacCtrlBSidebarToggle, sidebarToggleLabel, withSidebarToggle } from "./sidebarShortcut";

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

  describe("Ctrl+B on a Mac", () => {
    const ctrlB = { key: "b", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };
    const on = (overrides: Partial<Parameters<typeof isMacCtrlBSidebarToggle>[0]> = {}) =>
      isMacCtrlBSidebarToggle({
        event: ctrlB,
        isMac: true,
        terminalFocus: false,
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        ...overrides,
      });

    it("toggles the sidebar: the rule itself (mod+b) is ⌘B there and never matched Ctrl+B", () => {
      expect(
        resolveShortcutCommand(ctrlB, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform: "MacIntel",
          context: { terminalFocus: false },
        }),
      ).not.toBe("sidebar.toggle");
      expect(on()).toBe(true);
      expect(on({ event: { ...ctrlB, key: "B" } })).toBe(true);
    });

    it("works with a daemon that doesn't send the rule", () => {
      const old = DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => rule.command !== "sidebar.toggle");
      expect(on({ keybindings: old })).toBe(true);
    });

    it("not in a terminal, not with other modifiers, not off a Mac (Ctrl+B is the rule there)", () => {
      expect(on({ terminalFocus: true })).toBe(false);
      expect(on({ event: { ...ctrlB, shiftKey: true } })).toBe(false);
      expect(on({ event: { ...ctrlB, metaKey: true } })).toBe(false);
      expect(on({ event: { ...ctrlB, key: "n" } })).toBe(false);
      expect(on({ isMac: false })).toBe(false);
    });

    it("leaves a person's own shortcut alone", () => {
      const moved = DEFAULT_RESOLVED_KEYBINDINGS.map((rule) =>
        rule.command === "sidebar.toggle"
          ? { ...rule, shortcut: { ...rule.shortcut, key: "\\" } }
          : rule,
      );
      expect(on({ keybindings: moved })).toBe(false);
    });
  });
});
