/**
 * Apps that can't be shown inside Uno Work (they refuse to be framed, or sit
 * behind the Uno sign-in) open in their own browser tab. The first click still
 * lands on the app's page here, which says so and names the app; after that
 * the click opens the tab right away (Misha 11.10: "I click the app and get a
 * page telling me to open a page").
 *
 * Remembered per browser, by the app's origin, for a month — long enough to
 * feel instant, short enough that an app which became showable is tried again.
 */
export const OWN_TAB_APPS_KEY = "uno-work:apps:own-tab";
export const OWN_TAB_TTL_MS = 30 * 24 * 60 * 60_000;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The stored record: origin → when it was last seen refusing; junk reads as none. */
export function parseOwnTabApps(raw: string | null): Readonly<Record<string, number>> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: Record<string, number> = {};
    for (const [origin, at] of Object.entries(value)) {
      if (typeof at === "number" && Number.isFinite(at)) out[origin] = at;
    }
    return out;
  } catch {
    return {};
  }
}

export function isOwnTabApp(
  record: Readonly<Record<string, number>>,
  url: string,
  now: number,
): boolean {
  const origin = originOf(url);
  if (origin === null) return false;
  const at = record[origin];
  return at !== undefined && now - at < OWN_TAB_TTL_MS;
}

/** The record after the daemon's answer for `url`: kept while blocked, dropped once it can be shown. */
export function withOwnTabVerdict(
  record: Readonly<Record<string, number>>,
  url: string,
  blocked: boolean,
  now: number,
): Readonly<Record<string, number>> {
  const origin = originOf(url);
  if (origin === null) return record;
  const next: Record<string, number> = {};
  for (const [key, at] of Object.entries(record)) {
    if (key !== origin && now - at < OWN_TAB_TTL_MS) next[key] = at;
  }
  if (blocked) next[origin] = now;
  return next;
}

function readRecord(): Readonly<Record<string, number>> {
  try {
    return parseOwnTabApps(window.localStorage.getItem(OWN_TAB_APPS_KEY));
  } catch {
    return {};
  }
}

/** This app is known to open only in its own tab (this browser saw it refuse). */
export function opensInOwnTab(url: string): boolean {
  if (typeof window === "undefined") return false;
  return isOwnTabApp(readRecord(), url, Date.now());
}

export function rememberOwnTabVerdict(url: string, blocked: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const next = withOwnTabVerdict(readRecord(), url, blocked, Date.now());
    window.localStorage.setItem(OWN_TAB_APPS_KEY, JSON.stringify(next));
  } catch {
    // Private mode / storage full: the app's page keeps saying it, nothing breaks.
  }
}
