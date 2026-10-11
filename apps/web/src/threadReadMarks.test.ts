import { describe, expect, it } from "vitest";

import {
  THREAD_READ_MARK_TTL_MS,
  isTurnRead,
  parseThreadReadMarks,
  threadReadMarkKey,
} from "./threadReadMarks";

const NOW_MS = Date.parse("2026-10-11T12:00:00.000Z");
const at = (agoMs: number) => new Date(NOW_MS - agoMs).toISOString();

describe("parseThreadReadMarks", () => {
  it("reads the stored marks", () => {
    const key = threadReadMarkKey("env", "thread");
    expect(parseThreadReadMarks(JSON.stringify({ [key]: at(1000) }), NOW_MS)).toEqual({
      [key]: at(1000),
    });
  });

  it("junk reads as no marks", () => {
    expect(parseThreadReadMarks(null, NOW_MS)).toEqual({});
    expect(parseThreadReadMarks("not json", NOW_MS)).toEqual({});
    expect(parseThreadReadMarks("[1]", NOW_MS)).toEqual({});
    expect(parseThreadReadMarks(JSON.stringify({ a: 1, b: "soon" }), NOW_MS)).toEqual({});
  });

  it("drops marks past the TTL", () => {
    const raw = JSON.stringify({ old: at(THREAD_READ_MARK_TTL_MS + 1000), fresh: at(1000) });
    expect(parseThreadReadMarks(raw, NOW_MS)).toEqual({ fresh: at(1000) });
  });
});

describe("isTurnRead", () => {
  it("covers the turn that finished before the mark", () => {
    expect(isTurnRead(at(1000), at(5000))).toBe(true);
    expect(isTurnRead(at(1000), at(1000))).toBe(true);
  });

  it("a turn that finished later is not read", () => {
    expect(isTurnRead(at(5000), at(1000))).toBe(false);
  });

  it("no mark, or no finished turn: not read", () => {
    expect(isTurnRead(null, at(1000))).toBe(false);
    expect(isTurnRead(undefined, at(1000))).toBe(false);
    expect(isTurnRead(at(1000), null)).toBe(false);
  });
});
