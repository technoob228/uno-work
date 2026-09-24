/**
 * Inbox items as system notifications (the browser's, or the desktop app's —
 * Electron shows the same web Notification natively). Off until the person
 * turns them on in the Inbox; only shown while the window is hidden or in the
 * background, so an item never pops up twice in front of the person.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "uno:inbox-system-notifications";

type Preference = "on" | "off";

const listeners = new Set<() => void>();

function readPreference(): Preference {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

export function systemNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** On = the person asked for them and the browser allows them. */
export function systemNotificationsEnabled(): boolean {
  return (
    systemNotificationsSupported() &&
    readPreference() === "on" &&
    window.Notification.permission === "granted"
  );
}

export type SystemNotificationsState = "unsupported" | "off" | "on" | "blocked";

function currentState(): SystemNotificationsState {
  if (!systemNotificationsSupported()) return "unsupported";
  if (window.Notification.permission === "denied") return "blocked";
  return systemNotificationsEnabled() ? "on" : "off";
}

export function useSystemNotificationsState(): SystemNotificationsState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentState,
    () => "unsupported" as const,
  );
}

/** Must run from a click: browsers only ask for permission after a gesture. */
export async function setSystemNotifications(on: boolean): Promise<SystemNotificationsState> {
  if (!systemNotificationsSupported()) return "unsupported";
  if (on && window.Notification.permission !== "granted") {
    await window.Notification.requestPermission().catch(() => "denied");
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // private mode: lasts for the session
  }
  for (const listener of listeners) listener();
  return currentState();
}

export function windowIsInFront(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function showSystemNotification(input: {
  readonly tag: string;
  readonly title: string;
  readonly body: string | null;
  readonly onClick: () => void;
}): void {
  if (!systemNotificationsEnabled() || windowIsInFront()) return;
  try {
    const notification = new window.Notification(input.title, {
      ...(input.body ? { body: input.body } : {}),
      tag: input.tag,
    });
    notification.addEventListener("click", () => {
      window.focus();
      input.onClick();
      notification.close();
    });
  } catch {
    // Some browsers only allow notifications from a service worker; the Inbox still has it.
  }
}
