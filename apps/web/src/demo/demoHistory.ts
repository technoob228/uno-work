/**
 * The demo's hash history (13.11). The demo's world lives in the page's own
 * query (`?world=new&plans=signin…`), the app's route in the hash. TanStack's
 * hash history glues the two together — `#/setup?step=start` plus
 * `?world=new` read as `/setup?step=start?world=new`, so `step` came out
 * unknown and a direct link opened the AI path's first step instead. Here the
 * route is the hash alone; the page's query stays the demo's.
 *
 * Not for the desktop app: its page has no query of its own.
 */
import { createBrowserHistory, type HistoryLocation } from "@tanstack/react-router";

/** `/setup?step=start#x` → its parts, as the history reads a location. */
export function splitRouteHref(href: string): {
  readonly href: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
} {
  const path = href.startsWith("/") ? href : `/${href}`;
  const hashAt = path.indexOf("#");
  const beforeHash = hashAt === -1 ? path : path.slice(0, hashAt);
  const searchAt = beforeHash.indexOf("?");
  return {
    href: path,
    pathname: searchAt === -1 ? beforeHash : beforeHash.slice(0, searchAt),
    search: searchAt === -1 ? "" : beforeHash.slice(searchAt),
    hash: hashAt === -1 ? "" : path.slice(hashAt),
  };
}

export function createDemoHashHistory() {
  return createBrowserHistory({
    parseLocation: (): HistoryLocation => {
      const route = window.location.hash.split("#").slice(1).join("#") || "/";
      const key = (Math.random() + 1).toString(36).slice(7);
      const state = (window.history.state as HistoryLocation["state"] | null) ?? {
        __TSR_index: 0,
        key,
        __TSR_key: key,
      };
      return { ...splitRouteHref(route), state };
    },
    createHref: (href) => `${window.location.pathname}${window.location.search}#${href}`,
  });
}
