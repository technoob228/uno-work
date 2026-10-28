/**
 * Keeps CHAT_DOCK_INSET_VAR in step with the chat dock under a full-screen
 * panel tab: the tab ends right above the dock while it is shown, and goes all
 * the way down once the chat is folded away (P1, 28.10).
 *
 * "Expanded" (recent messages over the tab) keeps the last size: the messages
 * lie over the tab for a moment, the tab doesn't jump.
 */
import { useLayoutEffect, useRef } from "react";

import { CHAT_DOCK_INSET_VAR, chatDockInsetPx, type ChatDockMode } from "./chatDock.logic";

export function useChatDockInset(
  dock: HTMLElement | null,
  input: { readonly active: boolean; readonly mode: ChatDockMode },
): void {
  const modeRef = useRef(input.mode);
  modeRef.current = input.mode;
  const folded = input.mode === "minimized";

  useLayoutEffect(() => {
    const root = document.documentElement;
    const clear = () => root.style.removeProperty(CHAT_DOCK_INSET_VAR);
    if (!input.active || folded || dock === null) {
      clear();
      return;
    }
    const measure = () => {
      if (modeRef.current === "expanded") return;
      const inset = chatDockInsetPx({
        mode: modeRef.current,
        viewportHeight: window.innerHeight,
        dockTop: dock.getBoundingClientRect().top,
      });
      if (inset === null) clear();
      else root.style.setProperty(CHAT_DOCK_INSET_VAR, `${inset}px`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(dock);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      clear();
    };
  }, [dock, input.active, folded]);
}
