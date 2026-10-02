import { useSyncExternalStore } from "react";

import { windowIsInFront } from "../inbox/systemNotifications";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

/** The window is visible and focused: the person can actually see it. */
export function useWindowInFront(): boolean {
  return useSyncExternalStore(subscribe, windowIsInFront, () => true);
}
