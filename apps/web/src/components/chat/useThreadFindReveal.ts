import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useRef, useState, type RefObject } from "react";

import type { ThreadFindMatch } from "./threadFind";
import { useThreadFindHighlights } from "./threadFindHighlights";

const VIEW_MARGIN = 96;
// The find bar floats over the top of the list: a match under it is not in view.
const FIND_BAR_CLEARANCE = 56;
// The list measures rows after they mount, and a chat just opened is still
// scrolling itself to the end: check again a few times that the match stayed.
const RECHECK_DELAYS_MS = [60, 180, 400];

function isMatchInView(
  target: Element | Range | null | undefined,
  container: HTMLElement | null,
): boolean {
  if (!target || !container) return false;
  const rect = target.getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  return (
    rect.height > 0 &&
    rect.top >= viewport.top + FIND_BAR_CLEARANCE &&
    rect.bottom <= viewport.bottom
  );
}

/** Scrolls the list until the target sits in view, below the find bar. */
function revealMatch(input: {
  readonly list: LegendListRef | null;
  readonly scroller: HTMLElement | null;
  readonly range: Range | null;
  readonly match: ThreadFindMatch | null;
  readonly rowIndex: number;
}): void {
  const { list, scroller, range, match, rowIndex } = input;
  if (!list || !match || rowIndex < 0) return;
  const row = scroller?.querySelector(`[data-message-id="${CSS.escape(match.messageId)}"]`);
  const target: Element | Range | null = range?.startContainer.isConnected ? range : (row ?? null);
  if (isMatchInView(target, scroller)) return;
  if (target && scroller) {
    const rect = target.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    const scroll = list.getState?.().scroll;
    // Taller than the view: its start goes up top.
    const delta =
      rect.height >= viewport.height - VIEW_MARGIN * 2 ||
      rect.top < viewport.top + FIND_BAR_CLEARANCE
        ? rect.top - viewport.top - VIEW_MARGIN
        : rect.bottom - viewport.bottom + VIEW_MARGIN;
    if (typeof scroll === "number") {
      list.scrollToOffset({ offset: scroll + delta, animated: false });
      return;
    }
  }
  void list.scrollToIndex({ index: rowIndex, animated: false, viewOffset: VIEW_MARGIN });
}

/**
 * Brings the active match into view and paints it. Rows are virtualized, so a
 * far match first needs the list to mount its row; only then is there text to
 * measure. Rows can arrive later too, when a chat opens from ⌘K.
 */
export function useThreadFindReveal(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly query: string;
  readonly match: ThreadFindMatch | null;
  readonly navigationId: number;
  /** The match's place among the list's rows, or -1 while it has none. */
  readonly rowIndex: number;
  /** Its row is hidden in a folded turn: open it. */
  readonly onMissingRow: (match: ThreadFindMatch) => void;
}): void {
  const { listRef, query, match, navigationId, rowIndex, onMissingRow } = input;
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const activeRangeRef = useRef<Range | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the list creates its scroller after mount; highlights need that node
  useEffect(() => {
    if (query.length === 0) {
      setContainer(null);
      return;
    }
    const node = listRef.current?.getScrollableNode?.();
    setContainer(node instanceof HTMLElement ? node : null);
  }, [listRef, query, rowIndex]);

  useThreadFindHighlights({
    container,
    query,
    activeMessageId: match?.messageId ?? null,
    activeOccurrence: match?.occurrence ?? 0,
    onActiveRange: (range) => {
      activeRangeRef.current = range;
    },
  });

  const matchKey = match ? `${navigationId}:${match.messageId}:${match.occurrence}` : null;
  // The rechecks fire later: they must see this render's list, not the one that set them.
  const latestRef = useRef({ match, rowIndex, container, onMissingRow });
  latestRef.current = { match, rowIndex, container, onMissingRow };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolling the virtualized list to the match is an imperative effect of selecting it
  useEffect(() => {
    const latest = latestRef.current;
    if (matchKey === null || !latest.match) return;
    if (latest.rowIndex < 0) {
      latest.onMissingRow(latest.match);
      return;
    }
    const reveal = () =>
      revealMatch({
        list: listRef.current,
        scroller: latestRef.current.container,
        range: activeRangeRef.current,
        match: latestRef.current.match,
        rowIndex: latestRef.current.rowIndex,
      });
    reveal();
    const timers = RECHECK_DELAYS_MS.map((delay) => window.setTimeout(reveal, delay));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [listRef, matchKey, rowIndex, container]);
}
