/**
 * ⌘⇧H / ⌘⇧F (Ctrl+Shift+H / F) open a new chat's computer / folder picker —
 * in the centred new chat and in Home's box (upstream T3 Code's
 * `composer.host`; Work 29.10). Works while typing in the message box; not in
 * the terminal. Only a picker on screen listens, so the keys do nothing
 * elsewhere. Returns the label for the picker's tooltip ("⇧⌘H"), or null.
 */
import { useEffect, useEffectEvent, useMemo } from "react";

import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { useServerKeybindings } from "../../rpc/serverState";
import { type PickerShortcutCommand, withAppShortcutDefaults } from "../appShortcuts.logic";

export function usePickerShortcut(
  command: PickerShortcutCommand,
  enabled: boolean,
  onTrigger: () => void,
): string | null {
  const serverKeybindings = useServerKeybindings();
  // An older computer doesn't send these rules: the defaults fill in.
  const keybindings = useMemo(
    () => withAppShortcutDefaults(serverKeybindings),
    [serverKeybindings],
  );
  const trigger = useEffectEvent(onTrigger);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Another picker on screen (or anything else) already took it.
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const resolved = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (resolved !== command) return;
      event.preventDefault();
      event.stopPropagation();
      trigger();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [command, enabled, keybindings]);

  return useMemo(
    () => (enabled ? shortcutLabelForCommand(keybindings, command) : null),
    [command, enabled, keybindings],
  );
}

/** "The computer this chat runs on (⇧⌘H)". */
export function withShortcutHint(text: string, shortcut: string | null): string {
  return shortcut ? `${text} (${shortcut})` : text;
}
