import { useEffect, useState } from "react";

const DEV_MODE_STORAGE_KEY = "ui_dev_mode";
const DEV_MODE_EVENT = "uno:dev-mode-change";

function readStoredDevMode(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(DEV_MODE_STORAGE_KEY) === "1";
}

export function useDevMode(): boolean {
  const [devMode, setDevModeState] = useState<boolean>(readStoredDevMode);

  useEffect(() => {
    const onChange = () => setDevModeState(readStoredDevMode());
    window.addEventListener(DEV_MODE_EVENT, onChange);
    return () => window.removeEventListener(DEV_MODE_EVENT, onChange);
  }, []);

  return devMode;
}

export function setDevMode(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DEV_MODE_STORAGE_KEY, value ? "1" : "0");
  window.dispatchEvent(new Event(DEV_MODE_EVENT));
}

export function toggleDevMode(): void {
  setDevMode(!readStoredDevMode());
}
