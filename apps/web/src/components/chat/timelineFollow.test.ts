import { describe, expect, it } from "vitest";

import {
  createTimelineFollowController,
  FOLLOWING,
  isNearEnd,
  navigationReleasesFollow,
  RELEASED_AWAY,
  transitionTimelineFollow,
  type TimelineFollow,
  type TimelineFollowEvent,
} from "./timelineFollow";

const run = (state: TimelineFollow, ...events: TimelineFollowEvent["type"][]) =>
  events.reduce((current, type) => transitionTimelineFollow(current, { type }), state);

describe("following the newest text (T67)", () => {
  it("a move up lets go; streaming text does not take it back", () => {
    expect(run(FOLLOWING, "navigated")).toEqual({ mode: "released", atEnd: true });
    // Still at the end right after the move: a chunk arriving must not re-arm.
    expect(run(FOLLOWING, "navigated", "reachedEnd")).toEqual({ mode: "released", atEnd: true });
    expect(run(FOLLOWING, "navigated", "leftEnd", "leftEnd")).toBe(RELEASED_AWAY);
  });

  it("coming back to the end, or sending, follows again", () => {
    expect(run(FOLLOWING, "navigated", "leftEnd", "reachedEnd")).toBe(FOLLOWING);
    expect(run(RELEASED_AWAY, "followEnd")).toBe(FOLLOWING);
  });

  it("a chunk that leaves the end for a frame does not let go", () => {
    expect(run(FOLLOWING, "leftEnd", "reachedEnd", "leftEnd")).toBe(FOLLOWING);
  });

  it("lets go on the reader's moves up, and on moves down only away from the end", () => {
    const at = { contentScrollsUp: true, awayFromEnd: false };
    const away = { contentScrollsUp: true, awayFromEnd: true };
    for (const source of ["wheel", "touch", "key"] as const) {
      expect(navigationReleasesFollow({ source, direction: "up" }, at)).toBe(true);
      expect(navigationReleasesFollow({ source, direction: "down" }, at)).toBe(false);
      expect(navigationReleasesFollow({ source, direction: "down" }, away)).toBe(true);
    }
    // Nothing above to read: a move up changes nothing.
    expect(
      navigationReleasesFollow(
        { source: "wheel", direction: "up" },
        { contentScrollsUp: false, awayFromEnd: false },
      ),
    ).toBe(false);
    expect(navigationReleasesFollow({ source: "pointer", onScrollbar: true }, at)).toBe(true);
    expect(navigationReleasesFollow({ source: "pointer", onScrollbar: false }, at)).toBe(false);
  });

  it("counts 40 px from the end as the end", () => {
    expect(isNearEnd({ scrollHeight: 1000, clientHeight: 500, scrollTop: 460 })).toBe(true);
    expect(isNearEnd({ scrollHeight: 1000, clientHeight: 500, scrollTop: 459 })).toBe(false);
  });

  it("tells the chat when follow changes, once", () => {
    const controller = createTimelineFollowController();
    const seen: string[] = [];
    const stop = controller.subscribe(() => seen.push(controller.get().mode));
    controller.dispatch({ type: "navigated" });
    controller.dispatch({ type: "navigated" });
    controller.release();
    controller.followEnd();
    controller.followEnd();
    stop();
    controller.release();
    expect(seen).toEqual(["released", "following"]);
  });
});
