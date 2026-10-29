import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vitest";

import { resolveShortcutCommand, type ShortcutEventLike } from "../keybindings";
import { withAppShortcutDefaults } from "./appShortcuts.logic";

function event(init: Partial<ShortcutEventLike> & { key: string }): ShortcutEventLike {
  return { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init };
}

const MAC = { platform: "MacIntel" } as const;

describe("default app shortcuts", () => {
  it("goes back and forward with ⌘[ / ⌘], not inside the terminal", () => {
    const back = event({ key: "[", code: "BracketLeft", metaKey: true });
    const forward = event({ key: "]", code: "BracketRight", ctrlKey: true });
    expect(resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, MAC)).toBe(
      "navigation.back",
    );
    expect(
      resolveShortcutCommand(forward, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
    ).toBe("navigation.forward");
    expect(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, {
        ...MAC,
        context: { terminalFocus: true },
      }),
    ).toBeNull();
  });

  it("keeps ⌘⇧[ / ⌘⇧] for the previous / next chat", () => {
    const previous = event({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
    expect(resolveShortcutCommand(previous, DEFAULT_RESOLVED_KEYBINDINGS, MAC)).toBe(
      "thread.previous",
    );
  });

  it("marks Done with ⌘⇧S and pins with ⌘⇧P", () => {
    expect(
      resolveShortcutCommand(
        event({ key: "s", metaKey: true, shiftKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        MAC,
      ),
    ).toBe("thread.settle");
    expect(
      resolveShortcutCommand(
        event({ key: "p", metaKey: true, shiftKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        MAC,
      ),
    ).toBe("thread.pin");
  });

  it("leaves ⌘Z to a focused text field unless the Undo note claimed it", () => {
    const undo = event({ key: "z", metaKey: true });
    expect(resolveShortcutCommand(undo, DEFAULT_RESOLVED_KEYBINDINGS, MAC)).toBe("thread.undo");
    expect(
      resolveShortcutCommand(undo, DEFAULT_RESOLVED_KEYBINDINGS, {
        ...MAC,
        context: { editableFocus: true },
      }),
    ).toBeNull();
    // ⌘⇧Z (redo) is never the chat Undo.
    expect(
      resolveShortcutCommand(
        event({ key: "z", metaKey: true, shiftKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        MAC,
      ),
    ).toBeNull();
  });
});

describe("withAppShortcutDefaults", () => {
  it("adds the defaults an older computer doesn't send", () => {
    const old = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) => !binding.command.startsWith("navigation.") && binding.command !== "thread.undo",
    );
    const merged = withAppShortcutDefaults(old);
    expect(
      resolveShortcutCommand(event({ key: "z", metaKey: true }), merged, MAC),
    ).toBe("thread.undo");
    expect(
      resolveShortcutCommand(event({ key: "[", code: "BracketLeft", metaKey: true }), merged, MAC),
    ).toBe("navigation.back");
  });

  it("lets the person's own rule win and leaves a complete list alone", () => {
    expect(withAppShortcutDefaults(DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      DEFAULT_RESOLVED_KEYBINDINGS,
    );
    const custom: ResolvedKeybindingsConfig = DEFAULT_RESOLVED_KEYBINDINGS.map((binding) =>
      binding.command === "thread.pin"
        ? { ...binding, shortcut: { ...binding.shortcut, key: "y" } }
        : binding,
    );
    const merged = withAppShortcutDefaults(custom);
    expect(merged).toBe(custom);
    expect(
      resolveShortcutCommand(event({ key: "p", metaKey: true, shiftKey: true }), merged, MAC),
    ).toBeNull();
  });
});
