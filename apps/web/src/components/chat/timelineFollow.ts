/**
 * Whether the chat keeps the newest text in view while the agent writes (T67,
 * Misha 24.11: "I want to pin myself at the start and read calmly while it
 * keeps typing"). Follow is let go by the reader's own move up — wheel,
 * trackpad, touch, keyboard, scrollbar — never by a distance threshold that a
 * fast stream outruns; reaching the end again, "Jump to latest" or sending a
 * message takes it back. After upstream timelineViewport.ts (T3 Code, #24045).
 */

/** At most this far from the end counts as being at the end (re-arms follow). */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export type TimelineFollow =
  | { readonly mode: "following" }
  | { readonly mode: "released"; readonly atEnd: boolean };

export type TimelineFollowEvent =
  | { readonly type: "navigated" }
  | { readonly type: "followEnd" }
  | { readonly type: "reachedEnd" }
  | { readonly type: "leftEnd" };

export const FOLLOWING: TimelineFollow = { mode: "following" };
export const RELEASED_AWAY: TimelineFollow = { mode: "released", atEnd: false };

export function transitionTimelineFollow(
  state: TimelineFollow,
  event: TimelineFollowEvent,
): TimelineFollow {
  switch (event.type) {
    case "navigated":
      return state.mode === "released" ? state : { mode: "released", atEnd: true };
    case "followEnd":
      return FOLLOWING;
    case "reachedEnd":
      // A move up that has not yet left the end stays released: the list must
      // report leaving and coming back, so a nudge at the end cannot re-arm.
      return state.mode === "released" && !state.atEnd ? FOLLOWING : state;
    case "leftEnd":
      // While following, every streamed chunk leaves the end for a frame.
      return state.mode === "released" && state.atEnd ? RELEASED_AWAY : state;
  }
}

/** One move the reader made in the timeline. */
export type TimelineNavigation =
  | { readonly source: "wheel"; readonly direction: "up" | "down" }
  | { readonly source: "touch"; readonly direction: "up" | "down" }
  | { readonly source: "pointer"; readonly onScrollbar: boolean }
  | { readonly source: "key"; readonly direction: "up" | "down" };

/**
 * Whether a move lets go of the newest text. Upward moves do whenever there is
 * anything above to read; downward ones only when already away from the end.
 */
export function navigationReleasesFollow(
  navigation: TimelineNavigation,
  viewport: { readonly contentScrollsUp: boolean; readonly awayFromEnd: boolean },
): boolean {
  switch (navigation.source) {
    case "wheel":
    case "touch":
    case "key":
      return navigation.direction === "up" ? viewport.contentScrollsUp : viewport.awayFromEnd;
    case "pointer":
      return navigation.onScrollbar ? viewport.contentScrollsUp : false;
  }
}

/** Distance from the end of a scroll node, in px. */
export function distanceFromEnd(node: {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}): number {
  return Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight);
}

export function isNearEnd(node: {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}): boolean {
  return distanceFromEnd(node) <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}

/**
 * The follow state of one chat view, shared by the timeline (which hears the
 * reader) and the chat around it (send, "Jump to latest", thread switch).
 */
export interface TimelineFollowController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly get: () => TimelineFollow;
  readonly dispatch: (event: TimelineFollowEvent) => TimelineFollow;
  /** Back to following the newest text (send, jump to latest, another chat). */
  readonly followEnd: () => void;
  /** The view moved away on purpose (find, a jump to an entry, "Your answer"). */
  readonly release: () => void;
}

export function createTimelineFollowController(
  initial: TimelineFollow = FOLLOWING,
): TimelineFollowController {
  let state = initial;
  const listeners = new Set<() => void>();
  const set = (next: TimelineFollow) => {
    if (next === state) return state;
    state = next;
    for (const listener of listeners) listener();
    return state;
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
    dispatch: (event) => set(transitionTimelineFollow(state, event)),
    followEnd: () => void set(FOLLOWING),
    release: () => void set(state.mode === "released" ? state : RELEASED_AWAY),
  };
}

const UP_KEYS = new Set(["PageUp", "Home", "ArrowUp"]);
const DOWN_KEYS = new Set(["PageDown", "End", "ArrowDown", " "]);
// Wide enough for an overlay scrollbar, which takes no layout space.
const SCROLLBAR_HIT_PX = 16;
const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true']";

/**
 * Whether a wheel or key over `target` scrolls the timeline itself, not a
 * scrollable block inside it (a wide table, a code block, a raw tool output).
 */
export function isTimelineScrollTarget(
  target: EventTarget | null,
  timeline: HTMLElement,
  deltaY: number,
  wheel?: Pick<WheelEvent, "deltaX" | "shiftKey">,
): boolean {
  if (!(target instanceof Element) || !timeline.contains(target) || deltaY === 0) return false;
  // Shift-wheel scrolls sideways; trackpads add vertical noise to a horizontal swipe.
  if (wheel?.shiftKey || Math.abs(wheel?.deltaX ?? 0) > Math.abs(deltaY)) return false;
  for (
    let element: Element | null = target;
    element && element !== timeline;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
    const canScroll =
      deltaY < 0
        ? element.scrollTop > 0
        : element.scrollTop < element.scrollHeight - element.clientHeight;
    if (
      canScroll ||
      style.overscrollBehaviorY === "contain" ||
      style.overscrollBehaviorY === "none"
    )
      return false;
  }
  return true;
}

/**
 * Hears the reader's moves in the timeline's scroll node until disposed:
 * wheel and trackpad, touch drags (with their direction), presses on the
 * scrollbar, and scroll keys aimed at the timeline or at the page body.
 */
export function listenTimelineNavigation(
  scrollNode: HTMLElement,
  onNavigate: (navigation: TimelineNavigation) => void,
): () => void {
  const handleWheel = (event: WheelEvent) => {
    if (event.ctrlKey || !isTimelineScrollTarget(event.target, scrollNode, event.deltaY, event))
      return;
    onNavigate({ source: "wheel", direction: event.deltaY < 0 ? "up" : "down" });
  };
  let touchY: number | null = null;
  const handleTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY ?? null;
  };
  const handleTouchMove = (event: TouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y === undefined || touchY === null) return;
    const delta = y - touchY;
    if (Math.abs(delta) < 2) return;
    touchY = y;
    // A finger moving down drags the content down: the reader goes up.
    onNavigate({ source: "touch", direction: delta > 0 ? "up" : "down" });
  };
  const handleTouchEnd = () => {
    touchY = null;
  };
  // Scrollbar drags send no wheel or touch; the node's own padding is its
  // target too, so only a press at its trailing edge counts.
  const handlePointerDown = (event: PointerEvent) =>
    onNavigate({
      source: "pointer",
      onScrollbar:
        event.target === scrollNode &&
        scrollNode.getBoundingClientRect().right - event.clientX <=
          Math.max(SCROLLBAR_HIT_PX, scrollNode.offsetWidth - scrollNode.clientWidth),
    });
  // A click on message text leaves focus on the body; keys scroll the timeline then too.
  const handleKeyDown = (event: KeyboardEvent) => {
    const direction = UP_KEYS.has(event.key) ? "up" : DOWN_KEYS.has(event.key) ? "down" : null;
    if (
      direction === null ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !(event.target instanceof Element)
    )
      return;
    const target = event.target;
    const onTimeline = scrollNode.contains(target);
    if (!onTimeline && target !== document.body && target !== document.documentElement) return;
    if (target.closest(EDITABLE_SELECTOR)) return;
    if (onTimeline && !isTimelineScrollTarget(target, scrollNode, direction === "up" ? -1 : 1))
      return;
    onNavigate({ source: "key", direction });
  };
  scrollNode.addEventListener("wheel", handleWheel, { passive: true });
  scrollNode.addEventListener("touchstart", handleTouchStart, { passive: true });
  scrollNode.addEventListener("touchmove", handleTouchMove, { passive: true });
  scrollNode.addEventListener("touchend", handleTouchEnd, { passive: true });
  scrollNode.addEventListener("touchcancel", handleTouchEnd, { passive: true });
  scrollNode.addEventListener("pointerdown", handlePointerDown, { passive: true });
  document.addEventListener("keydown", handleKeyDown);
  return () => {
    scrollNode.removeEventListener("wheel", handleWheel);
    scrollNode.removeEventListener("touchstart", handleTouchStart);
    scrollNode.removeEventListener("touchmove", handleTouchMove);
    scrollNode.removeEventListener("touchend", handleTouchEnd);
    scrollNode.removeEventListener("touchcancel", handleTouchEnd);
    scrollNode.removeEventListener("pointerdown", handlePointerDown);
    document.removeEventListener("keydown", handleKeyDown);
  };
}
