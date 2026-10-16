/**
 * A folder of thousands (Misha 16.10 p.11): draw the first screenfuls right
 * away and the rest a frame later — the rows below the fold arrive before
 * anyone scrolls to them, and the folder shows as fast as a small one.
 */
import { useEffect, useState } from "react";

export const FIRST_ROWS = 200;

/** How many of `total` rows to draw now. */
export function useProgressiveRows(total: number, first = FIRST_ROWS): number {
  const [shown, setShown] = useState(first);
  useEffect(() => {
    if (total <= shown) return;
    const id = window.setTimeout(() => setShown(total), 0);
    return () => window.clearTimeout(id);
  }, [total, shown]);
  return Math.min(total, Math.max(shown, first));
}
