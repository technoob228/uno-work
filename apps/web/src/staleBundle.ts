/**
 * The page always runs the interface of the computer it works on (0.0.117).
 *
 * In the browser the interface (this bundle) comes from the daemon of the
 * machine the tab was opened through — on app.uno4.work (or an account's own
 * `<label>.uno4.work`) that is the machine Uno serves there. Switching to
 * another computer used to keep this bundle and only point it at the other
 * daemon, so a person on a 0.0.108 machine switching to a 0.0.116 one kept
 * the old interface with no way out: a reload served the old bundle again.
 *
 * Now:
 *   - switching (or opening an account computer) in the browser on a Work
 *     address, when the target's version differs or is not known yet, is a
 *     full load of `/_work/open?box=N`: the console remembers the choice and
 *     serves that computer's own interface on this address
 *     (fishcode api/work_machine_choice.go);
 *   - a global notice "A new version of Uno Work is ready · Reload" when the
 *     computer in use runs another version than this page — and only where a
 *     reload actually fixes it;
 *   - a chunk of an older bundle that is gone (`vite:preloadError`) reloads
 *     the page once instead of breaking it.
 *
 * Everything here is plain functions over injected inputs so the rules are
 * unit-tested without a browser.
 */
import { APP_VERSION } from "./branding";
import { isWorkProxyHost } from "./hooks/useDirectMachineAddress";
import { isElectron } from "./env";
import { isWebLite } from "./lite/flag";

/** Console route on Work addresses: remember computer N and serve its interface. */
export const WORK_OPEN_PATH = "/_work/open";

export function workMachineOpenUrl(boxId: number, next?: string): string {
  const params = new URLSearchParams({ box: String(Math.trunc(boxId)) });
  if (next && next.startsWith("/") && !next.startsWith("//") && next !== "/") {
    params.set("next", next);
  }
  return `${WORK_OPEN_PATH}?${params.toString()}`;
}

export interface StaleBundlePage {
  /** Served by the console's Work proxy (app.uno4.work or `<label>.uno4.work`). */
  readonly onWorkProxyHost: boolean;
  readonly isElectron: boolean;
  readonly isLite: boolean;
  readonly bundleVersion: string;
}

export function currentStaleBundlePage(): StaleBundlePage {
  return {
    onWorkProxyHost:
      typeof window !== "undefined" && isWorkProxyHost(window.location.hostname || ""),
    isElectron,
    isLite: isWebLite,
    bundleVersion: APP_VERSION,
  };
}

export interface StaleBundleMachine {
  /** The machine that served this page. */
  readonly isPrimary: boolean;
  /** Its box id in Uno, when it is an Uno computer. */
  readonly unoBoxId: number | null;
  /** Its daemon version; null while not known (not connected yet). */
  readonly serverVersion: string | null;
}

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim().replace(/^v/i, "");
  return trimmed ? trimmed : null;
}

/** -1 / 0 / 1; unparsable parts compare as text so "different" stays different. */
export function compareWorkVersions(a: string, b: string): number {
  const pa = (normalizeVersion(a) ?? "").split(/[.+-]/);
  const pb = (normalizeVersion(b) ?? "").split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function sameVersion(a: string | null, b: string | null): boolean {
  const na = normalizeVersion(a);
  const nb = normalizeVersion(b);
  return na !== null && nb !== null && compareWorkVersions(na, nb) === 0;
}

/**
 * Where a switch to `target` must load the page instead of switching in place:
 * the browser on a Work address, an Uno computer other than the one that
 * served the page, and its version differs from this bundle or is unknown.
 * Same version — the in-place switch is instant and the interface already
 * matches. The desktop app and lite have no other bundle to load.
 */
export function switchReloadUrl(
  page: StaleBundlePage,
  target: StaleBundleMachine,
  next?: string,
): string | null {
  if (!page.onWorkProxyHost || page.isElectron || page.isLite) return null;
  if (target.isPrimary || target.unoBoxId === null || target.unoBoxId <= 0) return null;
  if (sameVersion(target.serverVersion, page.bundleVersion)) return null;
  return workMachineOpenUrl(target.unoBoxId, next);
}

export type StaleBundleNotice = {
  /** The computer runs a newer interface than this page, or an older one. */
  readonly kind: "newer" | "older";
  readonly clientVersion: string;
  readonly serverVersion: string;
  /** Full page load that fixes it: a plain reload or the computer's address. */
  readonly reload: { readonly kind: "reload" } | { readonly kind: "open"; readonly url: string };
  /** Stable per (computer, page version, computer version) for "Later". */
  readonly key: string;
};

/**
 * The global notice for the computer in use, or null. Shown only where a
 * full load gives the person the matching interface:
 *   - the computer that served the page updated itself → a reload;
 *   - another Uno computer on a Work address → its address;
 * never in the desktop app or lite, never when the version is unknown.
 */
export function resolveStaleBundleNotice(
  page: StaleBundlePage,
  active: StaleBundleMachine & { readonly environmentId: string },
): StaleBundleNotice | null {
  if (page.isElectron || page.isLite) return null;
  const client = normalizeVersion(page.bundleVersion);
  const server = normalizeVersion(active.serverVersion);
  if (!client || !server || client === "0.0.0" || compareWorkVersions(client, server) === 0) {
    return null;
  }
  let reload: StaleBundleNotice["reload"];
  if (active.isPrimary) {
    reload = { kind: "reload" };
  } else {
    const url = switchReloadUrl(page, active);
    if (!url) return null;
    reload = { kind: "open", url };
  }
  return {
    kind: compareWorkVersions(server, client) > 0 ? "newer" : "older",
    clientVersion: client,
    serverVersion: server,
    reload,
    key: `${active.environmentId}:${client}:${server}`,
  };
}

// ---- vite:preloadError: a chunk of the previous bundle is gone ----

export const PRELOAD_RELOAD_STORAGE_KEY = "uno-work:preload-reload-at";
/** One automatic reload per tab per this window; a second failure is a real error. */
export const PRELOAD_RELOAD_WINDOW_MS = 60_000;

export interface PreloadReloadDeps {
  readonly now: () => number;
  readonly readLastReloadAt: () => number;
  readonly writeLastReloadAt: (at: number) => void;
  readonly reload: () => void;
}

/** "reload" — the page reloads (and the error is swallowed); "skip" — leave it to error UI. */
export function handlePreloadError(deps: PreloadReloadDeps): "reload" | "skip" {
  const now = deps.now();
  const last = deps.readLastReloadAt();
  if (Number.isFinite(last) && last > 0 && now - last < PRELOAD_RELOAD_WINDOW_MS) {
    return "skip";
  }
  deps.writeLastReloadAt(now);
  deps.reload();
  return "reload";
}

function readSession(key: string): number {
  try {
    return Number(window.sessionStorage.getItem(key) ?? 0);
  } catch {
    return 0;
  }
}

function writeSession(key: string, at: number): void {
  try {
    window.sessionStorage.setItem(key, String(at));
  } catch {
    // No storage: the window check cannot hold, but one reload is still fine.
  }
}

/** Call once at startup (main.tsx). */
export function installPreloadErrorReload(target: Window = window): void {
  target.addEventListener("vite:preloadError", (event) => {
    const action = handlePreloadError({
      now: () => Date.now(),
      readLastReloadAt: () => readSession(PRELOAD_RELOAD_STORAGE_KEY),
      writeLastReloadAt: (at) => writeSession(PRELOAD_RELOAD_STORAGE_KEY, at),
      reload: () => target.location.reload(),
    });
    // Reloading: keep Vite from rethrowing into the app while the page goes.
    if (action === "reload") event.preventDefault();
  });
}

// ---- "Later" on the notice, per tab ----

const NOTICE_DISMISSED_STORAGE_KEY = "uno-work:stale-bundle-later";

export function isStaleBundleNoticeDismissed(key: string): boolean {
  try {
    return window.sessionStorage.getItem(NOTICE_DISMISSED_STORAGE_KEY) === key;
  } catch {
    return false;
  }
}

export function dismissStaleBundleNotice(key: string): void {
  try {
    window.sessionStorage.setItem(NOTICE_DISMISSED_STORAGE_KEY, key);
  } catch {
    // best effort
  }
}

export const STALE_BUNDLE_COPY = {
  newerTitle: "A new version of Uno Work is ready",
  newerBody: (version: string) =>
    `Reload to use ${version}. Your chats and files stay as they are.`,
  olderTitle: (label: string, version: string) => `${label} runs Uno Work ${version}`,
  olderBody: "Reload to open it in its own version. Your chats and files stay as they are.",
  reload: "Reload",
  later: "Later",
} as const;
