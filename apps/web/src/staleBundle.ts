/**
 * A tab that keeps running an older Uno Work than its computer serves (08.10).
 *
 * After Uno Work updates on a computer (from the app, from the console, by a
 * reinstall) an open or restored tab keeps the old bundle: only the tab that
 * pressed Update used to reload, and a page restored from the browser's cache
 * after the update was taken for the new one. Here the tab compares its own
 * version with the one the daemon announces in every `welcome` (each connect
 * and reconnect) and reloads itself — only for the daemon that served this
 * page, never in the desktop app, once per version so a mismatch that a reload
 * doesn't cure can't loop.
 *
 * Old lazy chunks: after the swap `/assets/<old hash>.js` is gone and the
 * dynamic import fails (`vite:preloadError`); the tab reloads once as well.
 */
import { APP_VERSION } from "./branding";
import { readPrimaryEnvironmentTarget } from "./environments/primary/target";
import { isElectron } from "./env";
import { isWebLite } from "./lite/flag";
import { onWelcome } from "./rpc/serverState";

const RELOAD_STORAGE_KEY = "uno:stale-bundle-reload:v1";
/** A second reload for the same reason within this window is a loop: stop. */
const RELOAD_GUARD_MS = 10 * 60_000;

interface ReloadMark {
  readonly reason: string;
  readonly at: number;
}

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed ? trimmed : null;
}

/** The page came from the daemon it talks to: its version is this page's version. */
export function isServedByPrimaryDaemon(): boolean {
  if (isElectron || isWebLite || import.meta.env.DEV) return false;
  return readPrimaryEnvironmentTarget()?.source === "window-origin";
}

export function staleBundleReloadReason(input: {
  readonly clientVersion: string | null | undefined;
  readonly serverVersion: string | null | undefined;
  readonly servedByPrimaryDaemon: boolean;
}): string | null {
  if (!input.servedByPrimaryDaemon) return null;
  const client = normalizeVersion(input.clientVersion);
  const server = normalizeVersion(input.serverVersion);
  if (!client || !server || client === server) return null;
  return `version:${client}->${server}`;
}

export function mayReload(reason: string, mark: ReloadMark | null, now: number): boolean {
  return !(mark && mark.reason === reason && now - mark.at < RELOAD_GUARD_MS);
}

function readMark(): ReloadMark | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReloadMark>;
    return typeof parsed.reason === "string" && typeof parsed.at === "number"
      ? { reason: parsed.reason, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

/** Remembers the reason and reloads; false when this reason already reloaded once. */
function reloadOnce(reason: string): boolean {
  if (!mayReload(reason, readMark(), Date.now())) return false;
  try {
    window.sessionStorage.setItem(RELOAD_STORAGE_KEY, JSON.stringify({ reason, at: Date.now() }));
  } catch {
    // No sessionStorage: no loop guard either — don't reload at all.
    return false;
  }
  window.location.reload();
  return true;
}

function isTyping(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return (
    active.isContentEditable ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && active.type !== "button" && active.type !== "checkbox")
  );
}

/**
 * Reload when it doesn't take anything from the person: right away if the tab
 * is hidden or nobody is typing, otherwise as soon as they leave the field or
 * the tab.
 */
function reloadWhenIdle(reason: string): () => void {
  if (document.visibilityState === "hidden" || !isTyping()) {
    reloadOnce(reason);
    return () => undefined;
  }
  const attempt = () => {
    if (document.visibilityState === "hidden" || !isTyping()) {
      cleanup();
      reloadOnce(reason);
    }
  };
  const cleanup = () => {
    document.removeEventListener("visibilitychange", attempt);
    document.removeEventListener("focusout", onFocusOut);
  };
  // focusout fires before focus moves on: look once the new element is active.
  const onFocusOut = () => setTimeout(attempt, 0);
  document.addEventListener("visibilitychange", attempt);
  document.addEventListener("focusout", onFocusOut);
  return cleanup;
}

/** Mount once for the primary connection; returns the cleanup. */
export function startStaleBundleReload(): () => void {
  if (!isServedByPrimaryDaemon()) return () => undefined;

  const onPreloadError = (event: Event) => {
    // The default throws in the importing code; a fresh page has the new chunks.
    if (reloadOnce(`chunk:${APP_VERSION}`)) event.preventDefault();
  };
  window.addEventListener("vite:preloadError", onPreloadError);

  let cancelPending: () => void = () => undefined;
  const unsubscribe = onWelcome((payload) => {
    const reason = staleBundleReloadReason({
      clientVersion: APP_VERSION,
      serverVersion: payload.environment.serverVersion,
      servedByPrimaryDaemon: true,
    });
    cancelPending();
    cancelPending = reason ? reloadWhenIdle(reason) : () => undefined;
  });

  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    cancelPending();
    unsubscribe();
  };
}
