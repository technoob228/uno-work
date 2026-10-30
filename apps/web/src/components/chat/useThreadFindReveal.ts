import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";

import type { ThreadFindMatch } from "./threadFind";
import { useThreadFindHighlights } from "./threadFindHighlights";

const VIEW_MARGIN = 96;
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
  return rect.height > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
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
  const missing = useEffectEvent(onMissingRow);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the list creates its scroller after mount; highlights need that node
  useEffect(() => {
    if (query.length === 0) {
      setContainer(null);
      return;
    }
    const node = listRef.current?.getScrollableNode?.();
    setContainer(node instanceof HTMLElement ? node : null);
  }, [listRef, query, rowIndex]);

  const reveal = useEffectEvent(() => {
    const list = listRef.current;
    if (!list || !match || rowIndex < 0) return;
    const range = activeRangeRef.current;
    const scroller = container;
    const row = scroller?.querySelector(`[data-message-id="${CSS.escape(match.messageId)}"]`);
    const target: Element | Range | null = range?.startContainer.isConnected
      ? range
      : (row ?? null);
    if (isMatchInView(target, scroller)) return;
    if (target && scroller) {
      const rect = target.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      const scroll = list.getState?.().scroll;
      // Taller than the view: its start goes up top.
      const delta =
        rect.height >= viewport.height - VIEW_MARGIN * 2 || rect.top < viewport.top
          ? rect.top - viewport.top - VIEW_MARGIN
          : rect.bottom - viewport.bottom + VIEW_MARGIN;
      if (typeof scroll === "number") {
        list.scrollToOffset({ offset: scroll + delta, animated: false });
        return;
      }
    }
    void list.scrollToIndex({ index: rowIndex, animated: false, viewOffset: VIEW_MARGIN });
  });

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
  const matchRef = useRef(match);
  matchRef.current = match;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolling the virtualized list to the match is an imperative effect of selecting it
  useEffect(() => {
    const current = matchRef.current;
    if (matchKey === null || !current) return;
    if (rowIndex < 0) {
      missing(current);
      return;
    }
    reveal();
    const timers = RECHECK_DELAYS_MS.map((delay) => window.setTimeout(() => reveal(), delay));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [matchKey, rowIndex, container]);
}
