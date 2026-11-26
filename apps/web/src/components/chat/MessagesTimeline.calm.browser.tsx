import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ReactNode, type RefObject } from "react";
import { commands, page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import { buildStreamFrames, type StreamFrame } from "./MessagesTimeline.stream.fixture";
import { createTimelineFollowController, type TimelineFollowController } from "./timelineFollow";
import { PreviewPaneProvider } from "../preview/PreviewPaneContext";

/**
 * T67: one streamed turn replayed against the real list, checking that nothing
 * moves under the reader. VITE_CALM_SHOTS=<dir> also saves every frame and a
 * log of where the rows sat (the before/after captures in the day report).
 */
const shotDir = import.meta.env.VITE_CALM_SHOTS as string | undefined;

const nextFrames = (count = 3) =>
  new Promise<void>((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

function Harness(props: {
  frame: StreamFrame;
  listRef: RefObject<LegendListRef | null>;
  follow: TimelineFollowController;
  width: number;
  height: number;
}): ReactNode {
  const { frame } = props;
  return (
    <PreviewPaneProvider>
      <div style={{ width: props.width, height: props.height }} className="bg-background">
        <MessagesTimeline
          isWorking={frame.isWorking}
          activeTurnInProgress={frame.isWorking}
          activeTurnId={frame.latestTurn.turnId}
          activeTurnStartedAt={frame.latestTurn.startedAt}
          listRef={props.listRef}
          follow={props.follow}
          timelineEntries={frame.timelineEntries}
          completionDividerBeforeEntryId={null}
          completionSummary={null}
          turnDiffSummaryByAssistantMessageId={new Map()}
          routeThreadKey="environment-local:thread-calm"
          onOpenTurnDiff={vi.fn()}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={vi.fn()}
          isRevertingCheckpoint={false}
          onImageExpand={vi.fn()}
          activeThreadEnvironmentId={EnvironmentId.make("environment-local")}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="24-hour"
          workspaceRoot={undefined}
          onIsAtEndChange={() => {}}
          latestTurn={frame.latestTurn}
        />
      </div>
    </PreviewPaneProvider>
  );
}

function measure(listRef: RefObject<LegendListRef | null>) {
  const node = listRef.current?.getScrollableNode() as HTMLElement | undefined;
  if (!node) return null;
  const top = node.getBoundingClientRect().top;
  const rows: Record<string, number> = {};
  for (const row of node.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom < top || rect.top > top + node.clientHeight) continue;
    rows[row.dataset.timelineRowId ?? "?"] = Math.round(rect.top - top);
  }
  return {
    scrollTop: Math.round(node.scrollTop),
    fromEnd: Math.round(node.scrollHeight - node.scrollTop - node.clientHeight),
    rows,
  };
}

const SCROLL_STEP_PX = 40;

/**
 * One trackpad move: the wheel event, then the scroll it makes, as the browser
 * does. (Playwright's wheel hovers first and stalls on a busy machine.)
 */
function trackpad(node: HTMLElement, deltaY: number) {
  node.dispatchEvent(new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
  node.scrollBy({ top: deltaY, behavior: "instant" });
}

/** Waits until the list stops moving: the same measure for a few frames (at most ~1 s). */
async function settle(listRef: RefObject<LegendListRef | null>) {
  let last = "";
  let same = 0;
  for (let frame = 0; frame < 60 && same < 4; frame += 1) {
    await nextFrames(1);
    const now = JSON.stringify(measure(listRef));
    same = now === last ? same + 1 : 0;
    last = now;
  }
}

interface FrameRecord {
  readonly label: string;
  readonly scrollTop: number;
  readonly fromEnd: number;
  /** Top of each row in view, px from the top of the list. */
  readonly rows: Record<string, number>;
}

async function play(input: {
  name: string;
  width: number;
  height: number;
  nextTurn?: boolean;
  /** After this frame the reader scrolls up until `row` starts at the top. */
  read?: { readonly after: string; readonly row: string };
  /** After the last frame, this many small trackpad moves (up or down). */
  scrollAfter?: { readonly steps: number; readonly direction: "up" | "down" };
  /** From this frame on, a small trackpad move up before every chunk. */
  nudgeFrom?: string;
}): Promise<FrameRecord[]> {
  const log: string[] = [];
  const records: FrameRecord[] = [];
  let nudging = false;
  const frames = buildStreamFrames({ nextTurn: input.nextTurn ?? false });
  const listRef = createRef<LegendListRef | null>();
  const follow = createTimelineFollowController();
  const harness = (frame: StreamFrame) => (
    <Harness
      frame={frame}
      listRef={listRef}
      follow={follow}
      width={input.width}
      height={input.height}
    />
  );
  const record = (label: string) => {
    const measured = measure(listRef);
    if (!measured) throw new Error(`No list at ${label}`);
    records.push({ label, ...measured });
    log.push(`${label} ${JSON.stringify(measured)}`);
  };
  const screen = await render(harness(frames[0]!));
  await page.viewport(input.width, input.height);
  try {
    for (const [index, frame] of frames.entries()) {
      if (frame.label === input.nudgeFrom) nudging = true;
      if (nudging) {
        const node = listRef.current?.getScrollableNode() as HTMLElement;
        trackpad(node, -30);
        await nextFrames(1);
        record(`${frame.label}:nudged`);
      }
      // Sending takes the newest text back, as ChatView does.
      const sent = frame.label === "sent" || frame.label === "next-sent";
      if (sent) {
        nudging = false;
        follow.followEnd();
      }
      await screen.rerender(harness(frame));
      await nextFrames();
      if (sent) await listRef.current?.scrollToEnd({ animated: false });
      await settle(listRef);
      record(frame.label);
      if (shotDir) {
        await page.screenshot({
          path: `${shotDir}/${input.name}/${String(index).padStart(2, "0")}-${frame.label}.png`,
        });
      }
      if (frame.label === input.read?.after) {
        // A trackpad: small upward steps until the row starts at the top.
        const node = listRef.current?.getScrollableNode() as HTMLElement;
        for (let step = 0; step < 80; step += 1) {
          const row = node.querySelector<HTMLElement>(`[data-timeline-row-id="${input.read.row}"]`);
          const offset = row
            ? row.getBoundingClientRect().top - node.getBoundingClientRect().top
            : -1;
          if (row && offset >= 0) break;
          trackpad(node, -40);
          await nextFrames(1);
        }
        await nextFrames();
        record(`${frame.label}+read`);
        if (shotDir) {
          await page.screenshot({
            path: `${shotDir}/${input.name}/${String(index).padStart(2, "0")}-${frame.label}-b-read.png`,
          });
        }
      }
    }
    const scrollAfter = input.scrollAfter ?? { steps: 0, direction: "down" };
    for (let step = 1; step <= scrollAfter.steps; step += 1) {
      const node = listRef.current?.getScrollableNode() as HTMLElement;
      const deltaY = scrollAfter.direction === "up" ? -SCROLL_STEP_PX : SCROLL_STEP_PX;
      trackpad(node, deltaY);
      await settle(listRef);
      const label = `${scrollAfter.direction}-${step}`;
      record(label);
      if (shotDir) {
        await page.screenshot({
          path: `${shotDir}/${input.name}/${String(frames.length + step).padStart(2, "0")}-${label}.png`,
        });
      }
    }
  } finally {
    await screen.unmount();
    if (shotDir) await commands.writeFile(`__calm_metrics__/${input.name}.txt`, log.join("\n"));
  }
  return records;
}

const at = (records: ReadonlyArray<FrameRecord>, label: string): FrameRecord => {
  const found = records.find((record) => record.label === label);
  if (!found) throw new Error(`No frame ${label}`);
  return found;
};
const between = (records: ReadonlyArray<FrameRecord>, from: string, to: string) =>
  records.slice(
    records.findIndex((record) => record.label === from),
    records.findIndex((record) => record.label === to) + 1,
  );

const NOTE = "a-note";
const WORKING = "working-indicator-row";

/** Rows in view in both frames, with how far each moved. */
function moves(from: FrameRecord, to: FrameRecord): Record<string, number> {
  const moved: Record<string, number> = {};
  for (const [id, top] of Object.entries(to.rows)) {
    const before = from.rows[id];
    if (before !== undefined) moved[id] = top - before;
  }
  return moved;
}

function expectStill(records: ReadonlyArray<FrameRecord>, row: string) {
  const [first, ...rest] = records;
  for (const record of rest) {
    expect(record.rows[row], `${row} at ${record.label}`).toBeDefined();
    expect(
      Math.abs(record.rows[row]! - first!.rows[row]!),
      `${row} at ${record.label}`,
    ).toBeLessThanOrEqual(1);
  }
}

/** Each record moved every row in view by `step` px, until the end was reached. */
function expectStepsOnly(records: ReadonlyArray<FrameRecord>, step: number) {
  let checked = 0;
  for (const [index, record] of records.entries()) {
    const previous = records[index - 1];
    if (
      !previous ||
      (step < 0 && previous.fromEnd <= -step) ||
      (step > 0 && previous.scrollTop < step)
    )
      continue;
    for (const [id, moved] of Object.entries(moves(previous, record))) {
      expect(Math.abs(moved - step), `${id} at ${record.label}`).toBeLessThanOrEqual(1);
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(0);
}

describe("MessagesTimeline while the agent writes (T67)", () => {
  it("follows the newest text at the end, and nothing above collapses", async () => {
    const records = await play({ name: "desktop-follow", width: 900, height: 640 });
    for (const record of between(records, "sent", "done")) {
      expect(record.fromEnd, record.label).toBeLessThanOrEqual(2);
    }
    // Steps in one group keep their height: the wait line does not hop back.
    expect(at(records, "read-2").rows[WORKING]).toBe(at(records, "thought").rows[WORKING]);
    // The end of the turn changes nothing on screen.
    expect(at(records, "done").rows).toEqual(at(records, "answer-2").rows);
    expect(at(records, "done").scrollTop).toBe(at(records, "answer-2").scrollTop);
  }, 240_000);

  it("desktop: a reader at the note's start stays there until the turn ends", async () => {
    const records = await play({
      name: "desktop-read",
      width: 900,
      height: 640,
      read: { after: "note-8", row: NOTE },
    });
    expect(at(records, "note-8+read").fromEnd).toBeGreaterThan(40);
    expectStill(between(records, "note-8+read", "done"), NOTE);
  }, 240_000);

  it("desktop: a small trackpad move up lets go at once", async () => {
    const records = await play({
      name: "desktop-trackpad",
      width: 900,
      height: 640,
      nudgeFrom: "note-5",
    });
    const nudged = between(records, "note-5:nudged", "done");
    for (const [index, record] of nudged.entries()) {
      if (index === 0) continue;
      expect(record.scrollTop, record.label).toBeLessThanOrEqual(nudged[index - 1]!.scrollTop);
    }
    expect(at(records, "done").rows).toEqual(at(records, "answer-2").rows);
  }, 240_000);

  it("phone: a reader at the note's start stays there until the turn ends", async () => {
    const records = await play({
      name: "phone-read",
      width: 390,
      height: 700,
      read: { after: "note-6", row: NOTE },
    });
    expect(at(records, "note-6+read").fromEnd).toBeGreaterThan(40);
    expectStill(between(records, "note-6+read", "done"), NOTE);
  }, 240_000);

  it("keeps a watched turn open under a reader who follows, then folds it out of view", async () => {
    const records = await play({
      name: "desktop-next-follow",
      width: 900,
      height: 640,
      nextTurn: true,
      scrollAfter: { steps: 6, direction: "up" },
    });
    const next = between(records, "next-sent", "next-note-9");
    expect(next.at(-1)!.rows).not.toHaveProperty("w-run-1");
    for (const record of next) {
      expect(record.fromEnd, record.label).toBeLessThanOrEqual(2);
      expect(record.rows[WORKING], record.label).toBe(next[0]!.rows[WORKING]);
    }
    // Moving up from the end folds the turn above; the view moves by the step alone.
    expectStepsOnly(between(records, "next-note-9", "up-6"), SCROLL_STEP_PX);
  }, 240_000);

  it("folds a watched turn only once it is off screen, without moving the view", async () => {
    const records = await play({
      name: "desktop-next",
      width: 900,
      height: 640,
      nextTurn: true,
      read: { after: "next-note-4", row: "w-run-1" },
      scrollAfter: { steps: 12, direction: "down" },
    });
    // Back at the last turn's steps while the next answer streams: nothing moves.
    expect(at(records, "next-note-4+read").fromEnd).toBeGreaterThanOrEqual(SCROLL_STEP_PX);
    expectStill(between(records, "next-note-4+read", "next-note-9"), "w-run-1");
    for (const record of between(records, "sent", "next-note-9")) {
      expect(record.rows, record.label).not.toHaveProperty("turn-fold:turn-calm");
    }
    // Scrolling down past it folds it, and every step moves the view by the step alone.
    const down = between(records, "next-note-9", "down-12");
    expect(down.at(-1)!.rows).not.toHaveProperty("w-run-1");
    expectStepsOnly(down, -SCROLL_STEP_PX);
  }, 240_000);
});
