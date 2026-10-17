/**
 * "Your browser" in the web version (Misha 16.10 p.14: "why is there still
 * no view of the tab right here?"). Ordinary sites don't embed in an iframe,
 * so a browser tab of the panel shows a page of the computer's own browser
 * instead: the live picture, clicks and typing straight away (the page is the
 * person's, not a chat's — no Take control), Comment / Debug, sign-ins kept
 * in the computer's browser profile. "Open in my browser" takes the address
 * out to a tab of this browser; the Companion extension is an advanced extra.
 *
 * The desktop app keeps its own <webview> in the panel, as before.
 *
 * Pure, so the rules are tested directly.
 */
import type { BrowserLivePage, BrowserLiveState } from "@t3tools/contracts";

/**
 * What a browser tab of the panel shows:
 *   - "panel"    — the page itself, in the panel (the desktop app's <webview>,
 *                  or the iframe of its demo);
 *   - "computer" — a page of the computer's browser for this tab (the web
 *                  version connected to a computer);
 *   - "outside"  — nothing to show it with: the page opens in a tab of this
 *                  browser (the web version with no computer yet).
 */
export type BrowserTabMode = "panel" | "computer" | "outside";

export function browserTabMode(input: {
  /** The desktop app (Electron), or its demo in a browser. */
  readonly desktopApp: boolean;
  /** The computer this web app runs from (its daemon has the browser). */
  readonly computer: boolean;
}): BrowserTabMode {
  if (input.desktopApp) return "panel";
  return input.computer ? "computer" : "outside";
}

const WINDOW_KEY_STORAGE_KEY = "uno_your_browser_window";

function randomKey(): string {
  // Not crypto.randomUUID: it's missing outside secure contexts (plain http).
  return Math.random().toString(36).slice(2, 12).padEnd(4, "0");
}

let session: { readonly windowKey: string; readonly sessionKey: string } | null = null;

/**
 * Whose pages are whose. Panel tab ids (`browser-3`) start again after a
 * reload and repeat in every window, so a tab's page key also carries this
 * window (kept across its reloads) and this load of the app: a new tab never
 * lands on a page left by an earlier load, and this window can tell its own
 * leftovers (sweepable) from another window's live tabs (not its business).
 */
export function yourBrowserSession(): { readonly windowKey: string; readonly sessionKey: string } {
  if (session) return session;
  let windowKey = "w";
  try {
    const saved = window.sessionStorage.getItem(WINDOW_KEY_STORAGE_KEY);
    if (saved && /^[a-z0-9]{4,16}$/.test(saved)) windowKey = saved;
    else {
      windowKey = randomKey();
      window.sessionStorage.setItem(WINDOW_KEY_STORAGE_KEY, windowKey);
    }
  } catch {
    windowKey = randomKey();
  }
  session = { windowKey, sessionKey: `${windowKey}-${randomKey()}` };
  return session;
}

/** The page key of one panel tab on the computer (BrowserLiveOpenInput.tab). */
export function yourBrowserTabKey(sessionKey: string, tabId: string): string {
  return `${sessionKey}.${tabId}`;
}

/**
 * A page this window left on the computer in an earlier load (a reload drops
 * the chat's tabs, and nothing closed their pages): close it. Pages of other
 * windows and of this load stay.
 */
export function isLeftoverPage(
  page: Pick<BrowserLivePage, "tab">,
  current: { readonly windowKey: string; readonly sessionKey: string },
): boolean {
  const key = page.tab ?? "";
  return key.startsWith(`${current.windowKey}-`) && !key.startsWith(`${current.sessionKey}.`);
}

/** The computer's page of this tab, if it has one open. */
export function findYourBrowserPage(
  state: Pick<BrowserLiveState, "pages"> | null,
  key: string,
): BrowserLivePage | null {
  return state?.pages.find((page) => page.tab === key) ?? null;
}

/** A page of someone's own panel tab: never the agent's, never an app window's. */
export function isPersonTabPage(page: Pick<BrowserLivePage, "tab">): boolean {
  return page.tab !== undefined && page.tab !== "";
}

export type YourBrowserView = "connecting" | "error" | "setup" | "opening" | "page";

/**
 * What the tab shows and whether to ask the computer for its page now. The
 * page is asked for once; asked again only after it went away (the browser
 * restarted for a proxy, the daemon restarted) — never in a loop on an error.
 */
export function yourBrowserStep(input: {
  readonly state: Pick<BrowserLiveState, "setup"> | null;
  readonly page: BrowserLivePage | null;
  /** An open is on its way (or the computer opens it once its browser is set up). */
  readonly asking: boolean;
  readonly error: string | null;
}): { readonly view: YourBrowserView; readonly ask: boolean } {
  if (input.state === null) return { view: "connecting", ask: false };
  if (input.page) return { view: "page", ask: false };
  if (input.error !== null) return { view: "error", ask: false };
  const view = input.state.setup.status === "ready" ? "opening" : "setup";
  return { view, ask: !input.asking };
}

/** A page with no address yet (a new tab): its address bar is empty and waits for one. */
export function isBlankPageUrl(url: string): boolean {
  return url === "" || url === "about:blank";
}
