/**
 * The sidebar's keyboard shortcut (`sidebar.toggle`, ⌘B / Ctrl+B by default).
 * A daemon older than 0.0.93 doesn't send the rule, so the default is added
 * here when the server's list has none.
 */
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { shortcutLabelForCommand } from "../../keybindings";

export function withSidebarToggle(
  keybindings: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (keybindings.some((binding) => binding.command === "sidebar.toggle")) return keybindings;
  const fallback = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => binding.command === "sidebar.toggle",
  );
  // Earlier rules lose to later ones: the default goes first, user rules win.
  return [...fallback, ...keybindings];
}

export function sidebarToggleLabel(keybindings: ResolvedKeybindingsConfig): string | null {
  return shortcutLabelForCommand(withSidebarToggle(keybindings), "sidebar.toggle");
}

/**
 * Ctrl+B on a Mac. The rule is `mod+b`, and `mod` on a Mac is ⌘, so Ctrl+B
 * did nothing there (validator, 0.0.105). It toggles the sidebar too, in the
 * same places ⌘B does (not while a terminal has focus: there Ctrl+B belongs
 * to the program inside), as long as the default rule is in force.
 */
export function isMacCtrlBSidebarToggle(input: {
  readonly event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;
  readonly isMac: boolean;
  readonly terminalFocus: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
}): boolean {
  const { event } = input;
  if (!input.isMac || input.terminalFocus) return false;
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (event.key.toLowerCase() !== "b") return false;
  // A person who moved the shortcut elsewhere keeps their own choice.
  return withSidebarToggle(input.keybindings).some(
    (binding) =>
      binding.command === "sidebar.toggle" &&
      binding.shortcut.key === "b" &&
      binding.shortcut.modKey &&
      !binding.shortcut.shiftKey &&
      !binding.shortcut.altKey,
  );
}
