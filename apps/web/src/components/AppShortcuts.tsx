import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import {
  releaseThreadUndoShortcut,
  threadUndoClaimsShortcut,
  undoLatestThreadAction,
} from "../hooks/showThreadUndoNotice";
import { toggleOpenThreadDone, toggleOpenThreadPin } from "../hooks/threadUndoActions";
import { resolveShortcutCommand } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { useServerKeybindings } from "../rpc/serverState";
import { resolveThreadRouteRef } from "../threadRoutes";
import {
  isAppShortcutCommand,
  isModifierOnlyKey,
  withAppShortcutDefaults,
} from "./appShortcuts.logic";
import { toastManager } from "./ui/toast";

/**
 * ⌘[ / ⌘] back and forward (upstream 829af7b73a), ⌘⇧S Done and ⌘⇧P pin for
 * the open chat (143341b0bc), ⌘Z undo of the last Done / snooze / unpin /
 * archive (5781b5240b). Mounted once in the app layout.
 */
export function AppShortcuts() {
  const serverKeybindings = useServerKeybindings();
  const keybindings = useMemo(() => withAppShortcutDefaults(serverKeybindings), [serverKeybindings]);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  useEffect(() => {
    // Typing in a field hands ⌘Z back to the field.
    const onInput = () => releaseThreadUndoShortcut();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          // Right after a chat action ⌘Z undoes it even from the message box.
          editableFocus: isEditableFocused(event.target) && !threadUndoClaimsShortcut(),
        },
      });
      if (command !== "thread.undo" && !isModifierOnlyKey(event.key)) releaseThreadUndoShortcut();
      if (!isAppShortcutCommand(command)) return;

      if (command === "thread.undo") {
        // Nothing to undo: leave ⌘Z to the page.
        if (!undoLatestThreadAction()) return;
      } else if (command === "navigation.back") {
        window.history.back();
      } else if (command === "navigation.forward") {
        window.history.forward();
      } else {
        if (!routeThreadRef) return;
        const run = command === "thread.settle" ? toggleOpenThreadDone : toggleOpenThreadPin;
        void run(routeThreadRef)
          .then((result) => {
            if (!result.ok) toastManager.add({ type: "info", title: result.reason });
          })
          .catch((error: unknown) =>
            toastManager.add({
              type: "error",
              title: command === "thread.settle" ? "Couldn't mark it done" : "Couldn't pin the chat",
              description: error instanceof Error ? error.message : String(error),
            }),
          );
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("input", onInput, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("input", onInput, true);
    };
  }, [keybindings, routeThreadRef]);

  return null;
}
