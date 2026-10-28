import { describe, expect, it } from "vitest";

import {
  noteReasoningDelta,
  REASONING_PROGRESS_EVERY_MS,
  REASONING_PROGRESS_FIRST_AFTER_MS,
  REASONING_PROGRESS_LABEL,
  REASONING_PROGRESS_TAIL_CHARS,
  reasoningProgressTaskId,
  reasoningTailLine,
  type ReasoningProgressState,
} from "./reasoningProgress.ts";

const words = (count: number, word = "step") => Array.from({ length: count }, () => word).join(" ");

function feed(deltas: ReadonlyArray<readonly [atMs: number, delta: string]>) {
  let state: ReasoningProgressState | undefined;
  const updates: Array<{ atMs: number; detail: string }> = [];
  for (const [atMs, delta] of deltas) {
    const next = noteReasoningDelta(state, delta, atMs);
    state = next.state;
    if (next.update) {
      expect(next.update.summary).toBe(REASONING_PROGRESS_LABEL);
      updates.push({ atMs, detail: next.update.detail });
    }
  }
  return { state, updates };
}

describe("reasoning progress", () => {
  it("short thinking shows nothing", () => {
    const { updates } = feed([
      [0, words(100)],
      [5_000, words(100)],
      [9_000, words(100)],
    ]);
    expect(updates).toEqual([]);
  });

  it("a long think shows a row after ~10 s, then at most one per 30 s", () => {
    const deltas: Array<[number, string]> = [];
    // 6 minutes of reasoning, a delta every second (Smart 25.10: 5 min 43 s).
    for (let second = 0; second <= 360; second += 1) deltas.push([second * 1000, `${words(8)} `]);
    const { updates } = feed(deltas);
    expect(updates[0]!.atMs).toBe(REASONING_PROGRESS_FIRST_AFTER_MS);
    for (let i = 1; i < updates.length; i += 1) {
      expect(updates[i]!.atMs - updates[i - 1]!.atMs).toBeGreaterThanOrEqual(
        REASONING_PROGRESS_EVERY_MS,
      );
    }
    // ~12 rows for 6 minutes, all collapsed into one in the chat.
    expect(updates.length).toBeGreaterThanOrEqual(11);
    expect(updates.length).toBeLessThanOrEqual(13);
  });

  it("waits for enough text even when time has passed", () => {
    const { updates } = feed([
      [0, "Hmm."],
      [15_000, " Let"],
      [16_000, ` ${words(60, "think")}`],
    ]);
    expect(updates.map((update) => update.atMs)).toEqual([16_000]);
  });

  it("the row carries the end of the reasoning as one line, cut on a word", () => {
    const text = `${words(200, "early")}\n\n## Plan\n- write **server.js** then \`tests\`\n  and run them`;
    const line = reasoningTailLine(text);
    expect(line.startsWith("…")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(REASONING_PROGRESS_TAIL_CHARS + 1);
    expect(line).not.toMatch(/[\n*`#]/);
    expect(line.endsWith("write server.js then tests and run them")).toBe(true);
    expect(line).not.toMatch(/…arly/);
    expect(reasoningTailLine("  short\nthought ")).toBe("short thought");
  });

  it("keeps a bounded tail, not the whole reasoning", () => {
    let state: ReasoningProgressState | undefined;
    for (let i = 0; i < 2_000; i += 1) state = noteReasoningDelta(state, `${words(20)} `, i).state;
    expect(state!.chars).toBeGreaterThan(100_000);
    expect(state!.text.length).toBeLessThanOrEqual(REASONING_PROGRESS_TAIL_CHARS * 2);
  });

  it("names the rows of one reasoning part with one task id", () => {
    expect(reasoningProgressTaskId("prt_1")).toBe("reasoning:prt_1");
  });
});
