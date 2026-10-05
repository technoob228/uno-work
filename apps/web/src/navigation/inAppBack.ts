/**
 * Home's "Back" (Rama 26.09: "from Home there's no way back to where I was")
 * used `history.back()` whenever the router had any entry before this one —
 * which on a fresh first screen was /setup, the "/" landing that bounces
 * straight back to Home, or the console that opened Work. Back is shown only
 * when the entry before is a screen inside Work worth returning to.
 *
 * The router numbers its entries (`__TSR_index`); every resolved navigation
 * records its path under that number (`rememberHistoryEntry`, wired in
 * router.ts), so the path one step back is known. After a reload the earlier
 * entries are unknown, and Back stays hidden rather than guess.
 */

const pathByIndex = new Map<number, string>();

/** Paths a person should not be sent back to from Home. */
const NOT_A_BACK_TARGET = /^\/(setup|onboarding|pair)(\/|$)/;

/** Pure: is `previousPath` a screen inside Work that Back may return to? */
export function isUsefulBackTarget(
  previousPath: string | null | undefined,
  currentPath: string,
): boolean {
  if (!previousPath) return false;
  if (previousPath === currentPath) return false;
  // The "/" landing redirects on to Home again: Back would do nothing.
  if (previousPath === "/") return false;
  return !NOT_A_BACK_TARGET.test(previousPath);
}

export function rememberHistoryEntry(index: number | undefined, pathname: string): void {
  if (typeof index !== "number" || !Number.isFinite(index)) return;
  pathByIndex.set(index, pathname);
}

/** The path of the entry one step back, when this window saw it. */
export function previousEntryPath(index: number | undefined): string | undefined {
  if (typeof index !== "number" || index <= 0) return undefined;
  return pathByIndex.get(index - 1);
}

/** Only for tests. */
export function resetHistoryEntries(): void {
  pathByIndex.clear();
}
