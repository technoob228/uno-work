/**
 * Safety net for errors React could not contain.
 *
 * An error thrown during render outside every error boundary makes React
 * unmount the whole root: the user is left with an empty page and no hint
 * (that is how the first visit after pairing went blank until a reload).
 * Instead: reload once — that is what fixed it for people by hand — and if
 * the same tab fails again within a minute, show a plain branded screen with
 * a Reload button rather than a white page.
 */

export const FATAL_RELOAD_STORAGE_KEY = "uno-work:fatal-reload-at";
export const FATAL_RELOAD_WINDOW_MS = 60_000;
export const FATAL_SCREEN_ID = "uno-work-fatal";

export interface FatalRecoveryDeps {
  readonly now: () => number;
  readonly readLastReloadAt: () => number;
  readonly writeLastReloadAt: (at: number) => void;
  readonly reload: () => void;
  readonly showScreen: () => void;
}

export type FatalRecoveryAction = "reload" | "screen";

export function recoverFromUncaughtError(deps: FatalRecoveryDeps): FatalRecoveryAction {
  const now = deps.now();
  const last = deps.readLastReloadAt();
  if (!Number.isFinite(last) || now - last > FATAL_RELOAD_WINDOW_MS) {
    deps.writeLastReloadAt(now);
    deps.reload();
    return "reload";
  }
  deps.showScreen();
  return "screen";
}

function readLastReloadAt(): number {
  try {
    return Number(window.sessionStorage.getItem(FATAL_RELOAD_STORAGE_KEY) ?? 0);
  } catch {
    return 0;
  }
}

function writeLastReloadAt(at: number): void {
  try {
    window.sessionStorage.setItem(FATAL_RELOAD_STORAGE_KEY, String(at));
  } catch {
    // Storage unavailable: worst case we show the screen instead of looping.
  }
}

/** Rendered outside the dead React root, so nothing can clear it. */
export function showFatalScreen(doc: Document = document): void {
  if (doc.getElementById(FATAL_SCREEN_ID)) return;
  const screen = doc.createElement("div");
  screen.id = FATAL_SCREEN_ID;
  screen.setAttribute("role", "alert");
  screen.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
    "padding:24px;background:var(--background,#fff);color:inherit;font-family:inherit;";
  screen.innerHTML =
    '<div style="max-width:360px">' +
    '<img src="/uno-mark.svg" alt="" width="48" height="48" style="display:block;margin-bottom:24px" />' +
    '<h1 style="font-size:22px;font-weight:600;margin:0 0 6px">Something went wrong opening Uno Work</h1>' +
    '<p style="margin:0 0 20px;opacity:.7;font-size:15px;line-height:1.45">Your computer is fine — the page just needs to be loaded again.</p>' +
    '<button type="button" style="font:inherit;font-size:14px;padding:8px 14px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer">Reload</button>' +
    "</div>";
  screen.querySelector("button")?.addEventListener("click", () => window.location.reload());
  doc.body.appendChild(screen);
}

/** `createRoot({ onUncaughtError })` handler. */
export function handleUncaughtRenderError(
  error: unknown,
  info: { componentStack?: string | undefined },
): void {
  console.error("[uno-work] uncaught render error", error, info.componentStack ?? "");
  recoverFromUncaughtError({
    now: () => Date.now(),
    readLastReloadAt,
    writeLastReloadAt,
    reload: () => window.location.reload(),
    // React clears the root after this callback; draw next to it, not in it.
    showScreen: () => window.setTimeout(() => showFatalScreen(), 0),
  });
}
