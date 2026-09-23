/**
 * Rules for the in-Uno app view, free of React so they are tested directly.
 */

/** `https://nextcloud-box.app.uno4.dev/apps/files` → `nextcloud-box.app.uno4.dev`. */
export function appHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Only web addresses are ever framed; anything else is refused by the route. */
export function parseAppUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Does this address belong to one of the computer's apps? The app view frames
 * only those — a crafted link must not dress an arbitrary site in Uno's
 * chrome. Matching is by origin, so an app's inner pages are fine.
 */
export function belongsToComputer(url: string, knownUrls: ReadonlyArray<string | null>): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return knownUrls.some((known) => {
    if (!known) return false;
    try {
      return new URL(known).origin === origin;
    } catch {
      return false;
    }
  });
}
