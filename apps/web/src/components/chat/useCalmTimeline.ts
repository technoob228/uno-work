/**
 * A calm chat while the agent writes (T67, Misha 24.11): the view follows the
 * newest text only while the reader is at the end, and a turn the reader
 * watched keeps its notes and steps where they were until they are scrolled
 * out of view, then folds into "Worked for …" without moving what is on screen.
 */
import type { LegendListRef } from "@legendapp/list/react";
import type { TurnId } from "@t3tools/contracts";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { TimelineEntry } from "../../session-logic";
import {
  computeStableMessagesTimelineRows,
  deriveSettledTurnFolds,
  lastFoldableRowIndex,
  unsettledTurnIdOf,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
  type TimelineLatestTurn,
} from "./MessagesTimeline.logic";
import {
  createTimelineFollowController,
  isNearEnd,
  listenTimelineNavigation,
  navigationReleasesFollow,
  type TimelineFollowController,
} from "./timelineFollow";

/** Returns a structurally-shared copy of `rows`: unchanged rows keep their object. */
export function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });
  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

const EMPTY_TURN_IDS: ReadonlySet<TurnId> = new Set();

/**
 * Turns that were being written while this chat was on screen. A finished one
 * stays open until scrolled past; a chat opened later shows it folded.
 */
export function useHeldOpenTurns(latestTurn: TimelineLatestTurn | null) {
  const unsettledTurnId = unsettledTurnIdOf(latestTurn);
  const [held, setHeld] = useState<ReadonlySet<TurnId>>(EMPTY_TURN_IDS);
  // Once a turn was written on screen, the wait line's room stays for the visit.
  const [watchedLive, setWatchedLive] = useState(false);
  let heldOpenTurnIds = held;
  if (unsettledTurnId !== null && !held.has(unsettledTurnId)) {
    heldOpenTurnIds = new Set(held).add(unsettledTurnId);
    setHeld(heldOpenTurnIds);
    if (!watchedLive) setWatchedLive(true);
  }
  const releaseHeldTurns = useCallback((turnIds: ReadonlyArray<TurnId>) => {
    setHeld((current) => {
      const next = new Set(current);
      for (const turnId of turnIds) next.delete(turnId);
      return next.size === current.size ? current : next;
    });
  }, []);
  return {
    heldOpenTurnIds,
    releaseHeldTurns,
    watchedLive: watchedLive || unsettledTurnId !== null,
  };
}

function scrollNodeOf(listRef: RefObject<LegendListRef | null>): HTMLElement | null {
  const node = listRef.current?.getScrollableNode?.();
  return node instanceof HTMLElement ? node : null;
}

/** Whether row `index` lies wholly above the top of the viewport. */
function rowIsAboveViewport(list: LegendListRef, node: HTMLElement, index: number): boolean {
  const state = list.getState();
  const element = state.elementAtIndex(index) as HTMLElement | undefined;
  if (element?.isConnected) {
    return element.getBoundingClientRect().bottom <= node.getBoundingClientRect().top + 1;
  }
  // Not rendered: the list keeps only rows near the viewport.
  return index < state.startBuffered;
}

/** A downward jump right after the reader moved up is the list's own follow, late. */
const LATE_FOLLOW_WINDOW_MS = 250;

export function useCalmTimeline(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly follow: TimelineFollowController | undefined;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly latestTurn: TimelineLatestTurn | null;
  readonly heldOpenTurnIds: ReadonlySet<TurnId>;
  readonly releaseHeldTurns: (turnIds: ReadonlyArray<TurnId>) => void;
  /** Find in chat holds the view on its match. */
  readonly findActive: boolean;
  /** A jump to an entry ("Waiting for you"): the view goes there and stays. */
  readonly jumpKey: string | null;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
}) {
  const { listRef, rows, heldOpenTurnIds, releaseHeldTurns, onIsAtEndChange } = input;
  const [ownController] = useState(createTimelineFollowController);
  const controller = input.follow ?? ownController;
  const isFollowing = () => controller.get().mode === "following";
  const following =
    useSyncExternalStore(controller.subscribe, isFollowing, isFollowing) && !input.findActive;

  // Where the reader stood when they let go, to undo the list's late follow.
  const releasedAtRef = useRef<{ readonly top: number; readonly until: number } | null>(null);

  const report = useCallback(() => {
    const node = scrollNodeOf(listRef);
    if (!node) return;
    const atEnd = isNearEnd(node);
    controller.dispatch({ type: atEnd ? "reachedEnd" : "leftEnd" });
    onIsAtEndChange(controller.get().mode === "following" || atEnd);
  }, [controller, listRef, onIsAtEndChange]);

  // The reader's own moves let go of the newest text.
  const hasList = rows.length > 0;
  useEffect(() => {
    const node = hasList ? scrollNodeOf(listRef) : null;
    if (!node) return;
    return listenTimelineNavigation(node, (navigation) => {
      if (controller.get().mode !== "following") return;
      const releases = navigationReleasesFollow(navigation, {
        contentScrollsUp: node.scrollHeight - node.clientHeight > 1,
        awayFromEnd: !isNearEnd(node),
      });
      if (!releases) return;
      releasedAtRef.current = {
        top: node.scrollTop,
        until: performance.now() + LATE_FOLLOW_WINDOW_MS,
      };
      controller.dispatch({ type: "navigated" });
    });
  }, [controller, hasList, listRef]);

  // Any other change of follow (send, "Jump to latest") tells the chat at once.
  useEffect(() => controller.subscribe(report), [controller, report]);

  // A jump to an entry puts the view somewhere on purpose: it stays there.
  const { jumpKey } = input;
  useEffect(() => {
    if (jumpKey !== null) controller.release();
  }, [controller, jumpKey]);

  const folds = useMemo(
    () =>
      heldOpenTurnIds.size === 0
        ? null
        : deriveSettledTurnFolds({
            timelineEntries: input.timelineEntries,
            latestTurn: input.latestTurn,
          }),
    [heldOpenTurnIds, input.timelineEntries, input.latestTurn],
  );
  const foldScrolledPastTurns = useCallback(() => {
    const list = listRef.current;
    const node = scrollNodeOf(listRef);
    // Following, the list keeps the end in view; a fold above would race it.
    if (!folds || !list || !node || controller.get().mode === "following") return;
    const ready: TurnId[] = [];
    for (const turnId of heldOpenTurnIds) {
      const fold = folds.get(turnId);
      if (!fold) continue;
      const index = lastFoldableRowIndex(rows, fold);
      if (index >= 0 && rowIsAboveViewport(list, node, index)) ready.push(turnId);
    }
    if (ready.length > 0) releaseHeldTurns(ready);
  }, [controller, folds, heldOpenTurnIds, listRef, releaseHeldTurns, rows]);

  // New rows can move a turn out of view too (a reader away from the end).
  useEffect(() => {
    if (!folds) return;
    const frame = requestAnimationFrame(foldScrolledPastTurns);
    return () => cancelAnimationFrame(frame);
  }, [folds, foldScrolledPastTurns]);

  const handleScroll = useCallback(() => {
    const node = scrollNodeOf(listRef);
    const released = releasedAtRef.current;
    if (node && released) {
      if (performance.now() > released.until) releasedAtRef.current = null;
      else if (node.scrollTop > released.top + 4 && isNearEnd(node)) {
        node.scrollTop = released.top;
        return;
      }
    }
    report();
    foldScrolledPastTurns();
  }, [foldScrolledPastTurns, listRef, report]);

  return { following, handleScroll, releaseFollow: controller.release };
}

/**
 * Where the chat opens: at its end, or at "Your answer" when the person comes
 * for an answer agents talked after (read once, when the first rows arrive).
 */
export function useTimelineOpening(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly openAtAnswer: boolean;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
  /** Opened at "Your answer": the view stays there while the chat goes on. */
  readonly releaseFollow: () => void;
}) {
  const { listRef, rows, openAtAnswer, onIsAtEndChange, releaseFollow } = input;
  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;
    if (previousRowCount > 0 || rows.length === 0) return;
    const answerIndex = openAtAnswer ? rows.findIndex((row) => row.kind === "answer-anchor") : -1;
    if (answerIndex < 0) onIsAtEndChange(true);
    else releaseFollow();
    const frameId = window.requestAnimationFrame(() => {
      if (answerIndex >= 0) {
        void listRef.current?.scrollToIndex?.({
          index: answerIndex,
          animated: false,
          viewOffset: 12,
        });
        return;
      }
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => window.cancelAnimationFrame(frameId);
    // Only the first rows decide where the chat opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listRef, onIsAtEndChange, rows.length]);
}
