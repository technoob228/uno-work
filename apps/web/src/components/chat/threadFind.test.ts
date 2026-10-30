import type { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  formatThreadFindCount,
  matchAtIndex,
  startingFindIndex,
  stepThreadFindIndex,
  threadFindOwnsShortcut,
} from "./threadFind";

const entry = (messageId: string, count: number, startIndex: number) => ({
  messageId: messageId as MessageId,
  count,
  startIndex,
});
const ENTRIES = [entry("a", 2, 0), entry("b", 1, 2), entry("c", 3, 3)];

describe("stepThreadFindIndex", () => {
  it("wraps both ways", () => {
    expect(stepThreadFindIndex(0, 3, -1)).toBe(2);
    expect(stepThreadFindIndex(2, 3, 1)).toBe(0);
    expect(stepThreadFindIndex(0, 0, 1)).toBe(0);
  });
});

describe("formatThreadFindCount", () => {
  it("counts from one and stays in range when results shrink", () => {
    expect(formatThreadFindCount(0, 3)).toBe("1/3");
    expect(formatThreadFindCount(9, 3)).toBe("3/3");
    expect(formatThreadFindCount(0, 0)).toBe("0/0");
  });
});

describe("matchAtIndex", () => {
  it("turns an overall index into a message and an occurrence", () => {
    expect(matchAtIndex(ENTRIES, 1)).toEqual({ messageId: "a", occurrence: 1 });
    expect(matchAtIndex(ENTRIES, 2)).toEqual({ messageId: "b", occurrence: 0 });
    expect(matchAtIndex(ENTRIES, 5)).toEqual({ messageId: "c", occurrence: 2 });
    expect(matchAtIndex(ENTRIES, 6)).toBeNull();
  });
});

describe("startingFindIndex", () => {
  it("starts on the message asked for, from ⌘K", () => {
    expect(startingFindIndex(ENTRIES, { messageId: "b" })).toBe(2);
  });

  it("starts on the newest match on screen", () => {
    expect(startingFindIndex(ENTRIES, { visible: new Set(["a", "b"]) })).toBe(2);
  });

  it("starts on the newest match when none is on screen", () => {
    expect(startingFindIndex(ENTRIES, { visible: new Set() })).toBe(5);
  });
});

describe("threadFindOwnsShortcut", () => {
  it("leaves ⌘F to the right panel while the keyboard is in it", () => {
    const inPanel = { closest: (selector: string) => (selector ? {} : null) };
    expect(threadFindOwnsShortcut(inPanel as unknown as Element)).toBe(false);
  });

  it("takes ⌘F in the chat and with nothing focused", () => {
    const inChat = { closest: () => null };
    expect(threadFindOwnsShortcut(inChat as unknown as Element)).toBe(true);
    expect(threadFindOwnsShortcut(null)).toBe(true);
  });
});
