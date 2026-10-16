/**
 * Where a browser tab the person opens goes — the chip "Opens in" in the
 * browser tab's address bar (plan 22, step 4).
 *
 *   - "app"      — the desktop app's own browser, right in the panel
 *                  (Electron <webview>, BrowserPane). Only in the desktop app.
 *   - "computer" — the chat computer's browser (LiveBrowserView): a live
 *                  picture, Take control / Hand back. Any client connected to
 *                  a computer whose daemon has the browser.
 *
 * The choice is the person's (`browserOpenIn`, per device). The agent's
 * browser commands don't follow it: they follow the daemon's
 * `browser.executor` (browserCommandRouter) — so a page the agent opened
 * stays where the agent works.
 *
 * Pure, so the rules are tested directly.
 */
import {
  BROWSER_LIVE_SETUP_PAGE_ID,
  type BrowserLivePage,
  type BrowserLiveState,
  type BrowserLiveSetupStatus,
  type BrowserOpenIn,
} from "@t3tools/contracts";

export type BrowserSource = "app" | "computer";

export const BROWSER_SOURCE_LABEL: Record<BrowserSource, string> = {
  app: "This app",
  computer: "The computer's browser",
};

/** The line under a source in the chip's menu. */
export const BROWSER_SOURCE_DESCRIPTION: Record<BrowserSource, string> = {
  app: "Right here in the panel, with your logins and phone sizes",
  computer: "Runs on the computer, also when the app is closed. Take control any time",
};

/** Same words as the launcher's two tiles (w0138, flag `panelLauncherV2`). */
export const BROWSER_SOURCE_LABEL_V2: Record<BrowserSource, string> = {
  app: "Browser",
  computer: "Agent's browser",
};

export const BROWSER_SOURCE_DESCRIPTION_V2: Record<BrowserSource, string> = {
  app: "On this device: you click, the agent sees. Comment and debug",
  computer: "On the computer: the agent works, you watch live. Take control any time",
};

/** The chip's words: the launcher's new ones with `panelLauncherV2`, else those of 0.0.137. */
export function browserSourceCopy(v2: boolean): {
  readonly label: Record<BrowserSource, string>;
  readonly description: Record<BrowserSource, string>;
} {
  return v2
    ? { label: BROWSER_SOURCE_LABEL_V2, description: BROWSER_SOURCE_DESCRIPTION_V2 }
    : { label: BROWSER_SOURCE_LABEL, description: BROWSER_SOURCE_DESCRIPTION };
}

/** The sources this client actually has, in menu order. */
export function availableBrowserSources(input: {
  /** The desktop app (it has <webview>). */
  readonly desktopApp: boolean;
  /** The chat's computer reports its browser (`subscribeBrowserLive` answered). */
  readonly computerBrowser: boolean;
}): BrowserSource[] {
  const sources: BrowserSource[] = [];
  if (input.desktopApp) sources.push("app");
  if (input.computerBrowser) sources.push("computer");
  return sources;
}

/** A choice needs two things to choose from: one source — no chip. */
export function showBrowserSourceChip(sources: ReadonlyArray<BrowserSource>): boolean {
  return sources.length >= 2;
}

/**
 * Where "Browser" (the launcher tile, "+") opens a page. The person's default
 * wins when this client has it; otherwise (and for "auto") the old rule: the
 * computer's browser when the chat's agents browse there (a cloud computer),
 * else the panel's own browser tab (the desktop webview, or the companion
 * extension's tab in the web build — as before the chip existed).
 */
export function resolveBrowserOpenSource(input: {
  readonly setting: BrowserOpenIn;
  readonly sources: ReadonlyArray<BrowserSource>;
  readonly agentsBrowseOnComputer: boolean;
  /**
   * The new launcher (`panelLauncherV2`, Misha 16.10): your site — this
   * device's browser — is always the default, whatever the setting and on a
   * cloud computer too; the agent's browser is its own button.
   */
  readonly siteFirst?: boolean;
}): BrowserSource {
  if (input.siteFirst) return "app";
  if (input.setting !== "auto" && input.sources.includes(input.setting)) return input.setting;
  return input.agentsBrowseOnComputer && input.sources.includes("computer") ? "computer" : "app";
}

/** "Use by default" is ticked only when the person chose this very source. */
export function isDefaultBrowserSource(setting: BrowserOpenIn, source: BrowserSource): boolean {
  return setting === source;
}

/** Ticking "Use by default" makes this source the default; unticking gives the choice back to Uno ("auto"). */
export function nextBrowserOpenIn(source: BrowserSource, checked: boolean): BrowserOpenIn {
  return checked ? source : "auto";
}

/**
 * What the panel does when the computer answered "open": its setup tab (the
 * browser is being set up), the page's tab (it is already in the machine's
 * state), or wait for the page to appear (BrowserLiveListener opens it).
 */
export function afterComputerBrowserOpen(input: {
  readonly resultPageId: string;
  readonly state: BrowserLiveState | null;
}):
  | { readonly kind: "setup" }
  | { readonly kind: "page"; readonly page: BrowserLivePage }
  | { readonly kind: "wait" } {
  if (input.resultPageId === BROWSER_LIVE_SETUP_PAGE_ID) return { kind: "setup" };
  const page = input.state?.pages.find((candidate) => candidate.pageId === input.resultPageId);
  return page ? { kind: "page", page } : { kind: "wait" };
}

/**
 * The setup tab goes away when the browser BECOMES ready (or is ready at the
 * first snapshot). A setup tab opened while it was already ready is the
 * placeholder "Opening the page…" of a person's Browser click: the page's own
 * tab replaces it, not the next state update.
 */
export function shouldCloseSetupTabOnState(
  previous: BrowserLiveSetupStatus | null,
  current: BrowserLiveSetupStatus,
): boolean {
  return current === "ready" && previous !== "ready";
}
