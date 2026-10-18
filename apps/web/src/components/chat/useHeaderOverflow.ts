import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

/**
 * The chat header folds instead of clipping (18.10): when the chat is narrow
 * (right panel open, small window, phone) the least needed items leave the
 * row for the "⋯" menu one by one, so the title keeps a few words and the
 * Panel button never slides under the panel.
 *
 * Items that can fold carry `data-header-item="<id>"` and sit directly in one
 * of the header's rows; everything else in the rows always stays. Folded
 * items stay mounted (hidden), so their dialogs and shortcuts keep working.
 */

/** How many pixels the chat's title keeps before buttons start to fold. */
export const HEADER_TITLE_KEEP_PX = 112;
/** The "⋯" button until it was measured once. */
const MORE_BUTTON_FALLBACK_PX = 28;

export interface HeaderOverflowItem {
  readonly id: string;
  /** Its width plus the gap next to it; 0 — renders nothing right now. */
  readonly cost: number;
  /** Leaves without a "⋯" entry (the project's name): no menu needed for it. */
  readonly silent?: boolean;
}

/**
 * Which items fold, given the room. `items` go in folding order: the first
 * one leaves first. The "⋯" button costs room too, once anything folds.
 */
export function pickFoldedHeaderItems(input: {
  readonly available: number;
  readonly fixed: number;
  readonly items: ReadonlyArray<HeaderOverflowItem>;
  readonly moreCost: number;
}): string[] {
  let total = input.fixed;
  for (const item of input.items) total += item.cost;
  const folded: string[] = [];
  let menuShown = false;
  for (const item of input.items) {
    if (total <= input.available) break;
    if (item.cost <= 0) continue;
    total -= item.cost;
    if (!item.silent && !menuShown) {
      total += input.moreCost;
      menuShown = true;
    }
    folded.push(item.id);
  }
  return folded;
}

function gapOf(element: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(element).columnGap) || 0;
}

function isShown(element: HTMLElement): boolean {
  return getComputedStyle(element).display !== "none";
}

export function useHeaderOverflow(
  order: ReadonlyArray<string>,
  silent: ReadonlyArray<string> = [],
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const widths = useRef(new Map<string, number>());
  const moreWidth = useRef(MORE_BUTTON_FALLBACK_PX);
  const [foldedKey, setFoldedKey] = useState("");
  const folded = useMemo(() => new Set(foldedKey ? foldedKey.split(",") : []), [foldedKey]);
  const foldedRef = useRef(folded);
  foldedRef.current = folded;
  const orderKey = order.join(",");
  const silentKey = silent.join(",");

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const rows = Array.from(root.children).filter(
      (row): row is HTMLElement => row instanceof HTMLElement && isShown(row),
    );
    let fixed = rows.length > 1 ? gapOf(root) * (rows.length - 1) : 0;
    const costs = new Map<string, number>();
    let moreGap = 8;
    for (const row of rows) {
      const gap = gapOf(row);
      let stays = 0;
      let shrinkableSeen = false;
      for (const child of Array.from(row.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const id = child.dataset.headerItem;
        if (id !== undefined) {
          // A folded item keeps the width it had while it was in the row.
          if (!foldedRef.current.has(id)) widths.current.set(id, child.offsetWidth);
          const width = widths.current.get(id) ?? 0;
          costs.set(id, width > 0 ? width + gap : 0);
          continue;
        }
        if (child.dataset.headerMore !== undefined) {
          if (child.offsetWidth > 0) moreWidth.current = child.offsetWidth;
          moreGap = gap;
          continue;
        }
        if (!isShown(child)) continue;
        const style = getComputedStyle(child);
        let need = child.offsetWidth;
        if (style.flexShrink !== "0") {
          // The title (the first thing that shrinks) keeps a few words; the
          // rest of what shrinks keeps its own min-width.
          const minWidth = Number.parseFloat(style.minWidth) || 0;
          const keep = shrinkableSeen ? minWidth : Math.max(HEADER_TITLE_KEEP_PX, minWidth);
          shrinkableSeen = true;
          need = Math.max(minWidth, Math.min(child.scrollWidth, keep));
        }
        fixed += need;
        stays += 1;
      }
      if (stays > 1) fixed += gap * (stays - 1);
    }
    const next = pickFoldedHeaderItems({
      available: root.clientWidth,
      fixed,
      items: orderKey.split(",").map((id) => ({
        id,
        cost: costs.get(id) ?? 0,
        silent: silentKey.split(",").includes(id),
      })),
      moreCost: moreWidth.current + moreGap,
    });
    setFoldedKey(next.toSorted().join(","));
  }, [orderKey, silentKey]);

  // Every render: the row's content may have changed (Done showed up, Dev
  // mode turned on), so measure again and watch the new children.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    for (const row of Array.from(root.children)) {
      observer.observe(row);
      for (const child of Array.from(row.children)) observer.observe(child);
    }
    return () => observer.disconnect();
  });

  const menuNeeded = [...folded].some((id) => !silentKey.split(",").includes(id));
  return { rootRef, folded, menuNeeded };
}
