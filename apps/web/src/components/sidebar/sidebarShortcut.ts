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
