/**
 * Inbox items as system notifications (the browser's, or the desktop app's —
 * Electron shows the same web Notification natively).
 *
 * On by default (decision 25.09) in the "when I'm needed" mode:
 * - an agent waits for an approval, asked a question, asked for help in the
 *   browser (`requestHelp` arrives as a question) or a chat failed → always,
 *   unless the person is already looking at that very chat;
 * - a task finished, an app said something → only while the window is in the
 *   background, so nothing pops up twice in front of the person.
 * Settings → General → Notifications changes it: also-finished (default),
 * only-needed, or off.
 *
 * A browser only shows them after the person allowed it, and only asks from a
 * click: with the default on and nothing decided yet, the first click in the
 * window asks once. The desktop app is allowed from the start.
 */
import type { InboxItemKind } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "uno:inbox-system-notifications";
const ASKED_KEY = "uno:inbox-system-notifications-asked";

/**
 * - `smart`     — when I'm needed, and finished tasks while I'm away (default);
 * - `needs-you` — only when I'm needed;
 * - `off`       — never.
 */
export type NotificationMode = "smart" | "needs-you" | "off";

export const NOTIFICATION_MODES: ReadonlyArray<{
  readonly value: NotificationMode;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "smart",
    label: "When needed + when done",
    hint: "Approvals, questions, a call for help in the browser and errors — always. Finished tasks only while Uno Work is in the background.",
  },
  {
    value: "needs-you",
    label: "Only when needed",
    hint: "Approvals, questions, a call for help in the browser and errors. Finished tasks stay in the Inbox.",
  },
  { value: "off", label: "Off", hint: "Everything stays in the Inbox." },
];

/** Kinds that need the person: notified even with the window in front. */
const NEEDS_PERSON: ReadonlySet<string> = new Set<InboxItemKind>([
  "agent.approval",
  "agent.input",
  "agent.error",
]);

const listeners = new Set<() => void>();

/** Stored value → mode. Nothing stored (or the old "on") = the default. */
export function parseNotificationMode(stored: string | null): NotificationMode {
  if (stored === "off") return "off";
  if (stored === "needs-you") return "needs-you";
  return "smart";
}

export function readNotificationMode(): NotificationMode {
  try {
    return parseNotificationMode(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "smart";
  }
}

/**
 * Should this item pop up? Pure: the caller knows whether the window is in
 * front and whether the person is looking at the item's chat.
 */
export function shouldNotify(input: {
  readonly mode: NotificationMode;
  readonly kind: string;
  readonly windowInFront: boolean;
  readonly viewingItsChat: boolean;
}): boolean {
  if (input.mode === "off") return false;
  if (NEEDS_PERSON.has(input.kind)) return !(input.windowInFront && input.viewingItsChat);
  return input.mode === "smart" && !input.windowInFront;
}

export function systemNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** On = the mode isn't off and the browser allows them. */
export function systemNotificationsEnabled(): boolean {
  return (
    systemNotificationsSupported() &&
    readNotificationMode() !== "off" &&
    window.Notification.permission === "granted"
  );
}

/**
 * - `on`      — they will show;
 * - `off`     — the person turned them off;
 * - `ask`     — on, but the browser hasn't been allowed yet (a click asks);
 * - `blocked` — the browser's settings block them.
 */
export type SystemNotificationsState = "unsupported" | "off" | "on" | "ask" | "blocked";

function currentState(): SystemNotificationsState {
  if (!systemNotificationsSupported()) return "unsupported";
  if (readNotificationMode() === "off") return "off";
  if (window.Notification.permission === "denied") return "blocked";
  return window.Notification.permission === "granted" ? "on" : "ask";
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSystemNotificationsState(): SystemNotificationsState {
  return useSyncExternalStore(subscribe, currentState, () => "unsupported" as const);
}

export function useNotificationMode(): NotificationMode {
  return useSyncExternalStore(subscribe, readNotificationMode, () => "smart" as const);
}

async function askPermission(): Promise<void> {
  if (!systemNotificationsSupported() || window.Notification.permission !== "default") return;
  try {
    window.localStorage.setItem(ASKED_KEY, "1");
  } catch {
    // private mode
  }
  await window.Notification.requestPermission().catch(() => "denied");
}

/** Must run from a click: browsers only ask for permission after a gesture. */
export async function setNotificationMode(
  mode: NotificationMode,
): Promise<SystemNotificationsState> {
  if (!systemNotificationsSupported()) return "unsupported";
  if (mode !== "off") await askPermission();
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // private mode: lasts for the session
  }
  notify();
  return currentState();
}

/** The bell toggle: on keeps the chosen mode (or the default), off is off. */
export async function setSystemNotifications(on: boolean): Promise<SystemNotificationsState> {
  const mode = readNotificationMode();
  return setNotificationMode(on ? (mode === "off" ? "smart" : mode) : "off");
}

/**
 * Default on in a browser that hasn't been asked: ask once, on the first
 * click or key press in the window. Returns the cleanup.
 */
export function askForPermissionOnFirstGesture(): () => void {
  if (!systemNotificationsSupported() || window.Notification.permission !== "default") {
    return () => undefined;
  }
  if (readNotificationMode() === "off") return () => undefined;
  try {
    if (window.localStorage.getItem(ASKED_KEY) === "1") return () => undefined;
  } catch {
    return () => undefined;
  }
  const onGesture = () => {
    cleanup();
    void askPermission().finally(notify);
  };
  const cleanup = () => {
    window.removeEventListener("pointerdown", onGesture, true);
    window.removeEventListener("keydown", onGesture, true);
  };
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
  return cleanup;
}

export function windowIsInFront(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function showSystemNotification(input: {
  readonly tag: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  /** The person is looking at the item's chat right now. */
  readonly viewingItsChat: boolean;
  readonly onClick: () => void;
}): void {
  if (!systemNotificationsEnabled()) return;
  if (
    !shouldNotify({
      mode: readNotificationMode(),
      kind: input.kind,
      windowInFront: windowIsInFront(),
      viewingItsChat: input.viewingItsChat,
    })
  ) {
    return;
  }
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
