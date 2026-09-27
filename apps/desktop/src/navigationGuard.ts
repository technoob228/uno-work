/**
 * Navigation and IPC trust rules for the desktop shell.
 *
 * The main window must only ever show the app itself (the local backend or,
 * in development, the Vite dev server). Anything else that tries to load into
 * it — a markdown link, an injected `location.href`, a `window.open` — is
 * either handed to the system browser (plain http/https) or dropped. IPC is
 * only served to frames that are the app itself, so a third-party page that
 * ends up inside the window can never reach the preload bridge.
 */

export type MainWindowNavigationDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "open-external"; readonly url: string }
  | { readonly kind: "deny" };

function parseUrl(rawUrl: unknown): URL | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/** Origins of the given URLs (http/https only); invalid or empty values are skipped. */
export function resolveTrustedOrigins(
  urls: ReadonlyArray<string | null | undefined>,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const url of urls) {
    const parsed = parseUrl(url ?? "");
    if (!parsed) continue;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    origins.add(parsed.origin);
  }
  return origins;
}

/** True when the URL is an http(s) URL whose origin is one of the app's own origins. */
export function isTrustedAppUrl(rawUrl: unknown, trustedOrigins: ReadonlySet<string>): boolean {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return false;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return trustedOrigins.has(parsed.origin);
}

/** Plain web URL (http/https) or null. */
export function toHttpUrl(rawUrl: unknown): string | null {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/**
 * What to do when something tries to navigate the main window (or open a new
 * window from it): stay on the app, hand web links to the system browser,
 * drop everything else (file:, javascript:, custom schemes, ...).
 */
export function decideMainWindowNavigation(
  rawUrl: unknown,
  trustedOrigins: ReadonlySet<string>,
): MainWindowNavigationDecision {
  if (isTrustedAppUrl(rawUrl, trustedOrigins)) return { kind: "allow" };
  const external = toHttpUrl(rawUrl);
  if (external) return { kind: "open-external", url: external };
  return { kind: "deny" };
}

/**
 * Embedded browser (<webview>) guests may only load web pages. `about:blank`
 * is allowed because Chromium uses it for fresh frames; `file:`, `chrome:`,
 * `devtools:`, `javascript:`, `data:` and custom schemes are refused.
 */
export function isAllowedWebviewUrl(rawUrl: unknown): boolean {
  if (rawUrl === "about:blank") return true;
  return toHttpUrl(rawUrl) !== null;
}

/**
 * Permissions a guest page may be granted without asking. Everything that
 * touches the person (camera, microphone, location, notifications, screen,
 * HID/USB/serial, MIDI, clipboard read) is denied by default.
 */
const DEFAULT_ALLOWED_GUEST_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
]);

export function isGuestPermissionAllowedByDefault(permission: string): boolean {
  return DEFAULT_ALLOWED_GUEST_PERMISSIONS.has(permission);
}
