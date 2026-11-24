/**
 * "Waiting for you" (T52): bring a feed entry into view and light it for a
 * moment. An entry folded away (the agents' talk after the answer, a finished
 * turn) is opened first; the jump happens once its row exists.
 */
import type { LegendListRef } from "@legendapp/list/react";
import type { TurnId } from "@t3tools/contracts";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

import type { TimelineEntry } from "../../session-logic";

/** How long the row the strip jumped to stays lit. */
const JUMP_HIGHLIGHT_MS = 2600;
/** Rows measure themselves after the first scroll: land again a few times. */
const RECHECK_DELAYS_MS = [120, 360, 800];

export function useTimelineJump(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly jumpTo: { readonly entryId: string; readonly navigationId: number } | null;
  readonly rows: ReadonlyArray<{ readonly id: string }>;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  /** What folds an entry away: the agents' talk after the answer, a finished turn. */
  readonly setAgentTalkExpanded: (expanded: boolean) => void;
  readonly setExpandedTurnIds: Dispatch<SetStateAction<ReadonlySet<TurnId>>>;
}): string | null {
  const { listRef, jumpTo } = input;
  // The entry's place among the list's rows, or -1 while it is folded away.
  const rowIndex = jumpTo ? input.rows.findIndex((row) => row.id === jumpTo.entryId) : -1;
  const [highlightRowId, setHighlightRowId] = useState<string | null>(null);
  const jumpKey = jumpTo ? `${jumpTo.navigationId}:${jumpTo.entryId}` : null;
  const latestRef = useRef(input);
  latestRef.current = input;
  const rowIndexRef = useRef(rowIndex);
  rowIndexRef.current = rowIndex;
  useEffect(() => {
    const latest = latestRef.current;
    if (jumpKey === null || !latest.jumpTo) return;
    if (rowIndexRef.current < 0) {
      const entry = latest.timelineEntries.find((item) => item.id === latest.jumpTo?.entryId);
      if (!entry) return;
      latest.setAgentTalkExpanded(true);
      const turnId = entry.kind === "message" ? entry.message.turnId : null;
      if (turnId) latest.setExpandedTurnIds((current) => new Set(current).add(turnId));
      return;
    }
    const reveal = () => {
      const index = rowIndexRef.current;
      if (index >= 0)
        void listRef.current?.scrollToIndex?.({ index, animated: false, viewOffset: 56 });
    };
    reveal();
    setHighlightRowId(latest.jumpTo.entryId);
    const timers = RECHECK_DELAYS_MS.map((delay) => window.setTimeout(reveal, delay));
    const clear = window.setTimeout(() => setHighlightRowId(null), JUMP_HIGHLIGHT_MS);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.clearTimeout(clear);
    };
  }, [listRef, jumpKey, rowIndex]);
  return highlightRowId;
}
