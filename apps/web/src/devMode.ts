import { useEffect, useState } from "react";

import type { DevModeState } from "./devMode.logic";

const DEV_MODE_STORAGE_KEY = "ui_dev_mode";
const DEV_MODE_CHANGED_AT_STORAGE_KEY = "ui_dev_mode_at";
const DEV_MODE_EVENT = "uno:dev-mode-change";

/** Dev mode as this device knows it; the sync with computers is in `DevModeSync`. */
export function readDevMode(): boolean {
  return readDevModeState().enabled;
}

export function readDevModeState(): DevModeState {
  if (typeof window === "undefined") return { enabled: false, changedAt: null };
  try {
    // No storage (a locked-down browser, a test window) reads as "off".
    return {
      enabled: window.localStorage?.getItem(DEV_MODE_STORAGE_KEY) === "1",
      changedAt: window.localStorage?.getItem(DEV_MODE_CHANGED_AT_STORAGE_KEY) ?? null,
    };
  } catch {
    return { enabled: false, changedAt: null };
  }
}

export function useDevMode(): boolean {
  const [devMode, setDevModeState] = useState<boolean>(readDevMode);

  useEffect(() => {
    const onChange = () => setDevModeState(readDevMode());
    window.addEventListener(DEV_MODE_EVENT, onChange);
    return () => window.removeEventListener(DEV_MODE_EVENT, onChange);
  }, []);

  return devMode;
}

/** Stores a state that came from a computer; it doesn't count as a new choice. */
export function writeDevModeState(state: DevModeState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DEV_MODE_STORAGE_KEY, state.enabled ? "1" : "0");
  if (state.changedAt === null) window.localStorage.removeItem(DEV_MODE_CHANGED_AT_STORAGE_KEY);
  else window.localStorage.setItem(DEV_MODE_CHANGED_AT_STORAGE_KEY, state.changedAt);
  window.dispatchEvent(new Event(DEV_MODE_EVENT));
}

export function setDevMode(value: boolean): void {
  writeDevModeState({ enabled: value, changedAt: new Date().toISOString() });
}

export function toggleDevMode(): void {
  setDevMode(!readDevMode());
}
