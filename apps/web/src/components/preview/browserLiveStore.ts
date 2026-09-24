/**
 * Live state of the machines' own browsers, per environment.
 *
 * Filled by BrowserLiveListener from `subscribeBrowserLive`; read by the live
 * browser tabs (LiveBrowserView) and by the "+" menu, which opens a page in the
 * machine's browser when the chat's agents browse there.
 */

import { useSyncExternalStore } from "react";
import type { BrowserLivePage, BrowserLiveState, EnvironmentId } from "@t3tools/contracts";

let states: Readonly<Record<string, BrowserLiveState>> = {};
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

export const setBrowserLiveState = (
  environmentId: EnvironmentId,
  state: BrowserLiveState | null,
): void => {
  if (state === null) {
    if (!(environmentId in states)) return;
    const { [environmentId]: _removed, ...rest } = states;
    states = rest;
  } else {
    states = { ...states, [environmentId]: state };
  }
  emit();
};

export const readBrowserLiveState = (environmentId: EnvironmentId): BrowserLiveState | null =>
  states[environmentId] ?? null;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useBrowserLiveState(
  environmentId: EnvironmentId | null | undefined,
): BrowserLiveState | null {
  return useSyncExternalStore(
    subscribe,
    () => (environmentId ? (states[environmentId] ?? null) : null),
    () => null,
  );
}

export function useBrowserLivePage(
  environmentId: EnvironmentId | null | undefined,
  pageId: string | null | undefined,
): BrowserLivePage | null {
  const state = useBrowserLiveState(environmentId);
  if (!state || !pageId) return null;
  return state.pages.find((page) => page.pageId === pageId) ?? null;
}

/** Id of the preview tab that shows one live page. */
export function liveBrowserTabId(environmentId: EnvironmentId, pageId: string): string {
  return `live:${environmentId}:${pageId}`;
}

/** Tab title: the page title, else its host, else a neutral name. */
export function liveBrowserTabName(page: Pick<BrowserLivePage, "title" | "url">): string {
  const title = page.title.trim();
  if (title) return title.length > 40 ? `${title.slice(0, 39)}…` : title;
  try {
    const host = new URL(page.url).hostname.replace(/^www\./, "");
    if (host) return host;
  } catch {
    // not a URL yet (blank page)
  }
  return "Browser";
}
