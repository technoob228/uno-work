/**
 * Sign-in popups of the panel browser (<webview> guests).
 *
 * "Continue with Google / Apple / Facebook" opens a small window with
 * `window.open(url, name, "width=…,height=…")` and waits for it to report
 * back through `window.opener`. Opening that URL as another panel tab loses
 * the opener and the sign-in never finishes, so a popup like this opens as a
 * real child window in the same session; everything else stays a panel tab.
 *
 * What still holds:
 *   - web pages only (http/https) — no about:, data:, file:, custom schemes;
 *   - nothing opens without a person's (or the agent's) click or key press in
 *     the page within the last few seconds, so ads can't spawn windows;
 *   - the popup is sandboxed, has no preload and no Node, may not open popups
 *     of its own, and keeps the guest navigation and permission rules.
 *
 * FedCM is switched off in the panel: Electron has no FedCM account chooser,
 * so Google's button (Pinterest, …) asks FedCM, gets an error and does
 * nothing. Without FedCM, Google Identity Services falls back to its popup.
 */

/** Blink runtime feature behind navigator.credentials.get({ identity }) (FedCM). */
export const FEDCM_BLINK_FEATURE = "FedCm";

/** A webview's disableBlinkFeatures with FedCM added (kept once). */
export function withoutFedCm(disabled: string | undefined): string {
  const features = (disabled ?? "")
    .split(",")
    .map((feature) => feature.trim())
    .filter((feature) => feature.length > 0 && feature !== FEDCM_BLINK_FEATURE);
  return [...features, FEDCM_BLINK_FEATURE].join(",");
}

/** Chromium's transient user activation lasts 5 s; a popup needs one. */
export const POPUP_USER_ACTIVATION_MS = 5_000;

/** Input that gives a page user activation (as Chromium counts it). */
const ACTIVATING_INPUT_TYPES: ReadonlySet<string> = new Set([
  "mouseDown",
  "mouseUp",
  "rawKeyDown",
  "keyDown",
  "char",
  "pointerDown",
  "pointerUp",
  "touchEnd",
  "gestureTap",
]);

export function isActivatingInput(type: string): boolean {
  return ACTIVATING_INPUT_TYPES.has(type);
}

export type GuestWindowOpenDecision =
  /** A sign-in style popup: a child window in the same session, opener kept. */
  | { readonly kind: "popup" }
  /** A link for a new tab (target=_blank and the like): a new panel tab. */
  | { readonly kind: "tab"; readonly url: string }
  | { readonly kind: "deny" };

export interface GuestWindowOpenRequest {
  readonly url: string;
  readonly disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
  /** Form POST into a new window: never a popup (it would lose the body as a tab too). */
  readonly hasPostBody?: boolean;
}

function webUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * What a panel page's `window.open` / target=_blank turns into.
 *
 * `disposition: "new-window"` is what Chromium reports for `window.open` with
 * window features (width/height/popup) — the shape of every sign-in popup.
 * Plain `window.open(url)` and target=_blank links report a tab disposition
 * and keep opening as panel tabs, as before.
 */
export function decideGuestWindowOpen(
  request: GuestWindowOpenRequest,
  userActivated: boolean,
): GuestWindowOpenDecision {
  const url = webUrl(request.url);
  if (!url) return { kind: "deny" };
  if (!userActivated) return { kind: "deny" };
  if (request.disposition === "new-window" && !request.hasPostBody) return { kind: "popup" };
  return { kind: "tab", url };
}

/**
 * Window options for an allowed popup. Popups don't pass through
 * will-attach-webview, so the hardening is spelled out here; the session
 * (cookies, sign-ins) is the opener's, which Electron keeps for window.open.
 */
export function popupWindowOptions(
  parent: Electron.BrowserWindow | null,
): Electron.BrowserWindowConstructorOptions {
  return {
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      javascript: true,
      disableBlinkFeatures: FEDCM_BLINK_FEATURE,
    },
  };
}

/** Last activating input per guest; the main process sees every input event. */
export function createUserActivationTracker(now: () => number = Date.now) {
  let lastActivationAt = Number.NEGATIVE_INFINITY;
  return {
    onInput(type: string): void {
      if (isActivatingInput(type)) lastActivationAt = now();
    },
    isActive(): boolean {
      return now() - lastActivationAt <= POPUP_USER_ACTIVATION_MS;
    },
  };
}
