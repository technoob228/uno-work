/**
 * App-wide shortcuts added 29.10 (T3 port): back / forward (⌘[ / ⌘]), Done
 * (⌘⇧S), pin (⌘⇧P) and Undo (⌘Z). A computer whose Work is older doesn't send
 * these rules, so the defaults are added here for any command the server's
 * list doesn't mention — the same trick as `withSidebarToggle`.
 */
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

export const APP_SHORTCUT_COMMANDS = [
  "navigation.back",
  "navigation.forward",
  "thread.settle",
  "thread.pin",
  "thread.undo",
] as const satisfies ReadonlyArray<KeybindingCommand>;

export type AppShortcutCommand = (typeof APP_SHORTCUT_COMMANDS)[number];

export function isAppShortcutCommand(command: string | null): command is AppShortcutCommand {
  return command !== null && (APP_SHORTCUT_COMMANDS as ReadonlyArray<string>).includes(command);
}

/**
 * ⌘⇧H / ⌘⇧F open a new chat's computer / folder picker. Not handled here:
 * each picker listens while it is on screen (`usePickerShortcut`).
 */
export const PICKER_SHORTCUT_COMMANDS = [
  "composer.host",
  "composer.folder",
] as const satisfies ReadonlyArray<KeybindingCommand>;

export type PickerShortcutCommand = (typeof PICKER_SHORTCUT_COMMANDS)[number];

const DEFAULTED_COMMANDS: ReadonlyArray<KeybindingCommand> = [
  ...APP_SHORTCUT_COMMANDS,
  ...PICKER_SHORTCUT_COMMANDS,
  "composer.sendBackground",
  "composer.sendAndNewThread",
  "composer.stash",
];

export function withAppShortcutDefaults(
  keybindings: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  const known = new Set<string>(keybindings.map((binding) => binding.command));
  const missing = DEFAULTED_COMMANDS.filter((command) => !known.has(command));
  if (missing.length === 0) return keybindings;
  const fallback = DEFAULT_RESOLVED_KEYBINDINGS.filter((binding) =>
    (missing as ReadonlyArray<string>).includes(binding.command),
  );
  // Earlier rules lose to later ones: the defaults go first, user rules win.
  return [...fallback, ...keybindings];
}

const MODIFIER_KEYS = new Set(["Meta", "OS", "Command", "Control", "Alt", "Option", "Shift"]);

/** A bare modifier press doesn't count as "typing something else" for ⌘Z's claim. */
export function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}
