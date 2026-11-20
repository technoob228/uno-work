import { describe, expect, it } from "vitest";

import {
  activityLine,
  backoffMs,
  batches,
  clipText,
  countTool,
  eventHash,
  NO_TOOLS,
  onStreamDelta,
  rememberSent,
  snapshotEvents,
  STREAM_EVERY_MS,
  TEAM_NOTE_PREFIX,
  threadStatusOf,
  unsent,
  type MirrorEvent,
  type MirrorMessage,
} from "./shareMirror.logic.ts";

const at = "2026-11-20T10:00:00.000Z";
const message = (
  id: string,
  role: string,
  text: string,
  turnId: string | null = null,
): MirrorMessage => ({ id, role, text, turnId, streaming: false, createdAt: at });

describe("the feed of a shared chat", () => {
  it("has what the person and the agent said, and one line per turn of what it did", () => {
    const tools = new Map([["t1", countTool(countTool(countTool(NO_TOOLS, "command_execution"), "command_execution"), "file_change")]]);
    const events = snapshotEvents(
      [
        message("m1", "user", "Fix the order form", "t1"),
        message("m2", "assistant", "Looking at it.", "t1"),
        message("m3", "assistant", "Fixed: the button was disabled.", "t1"),
        message("m4", "system", "internal"),
        message("m5", "user", `${TEAM_NOTE_PREFIX} a message from Andrei …`),
        message("m6", "user", "   "),
      ],
      tools,
    );
    expect(events.map((event) => [event.messageId, event.role, event.text])).toEqual([
      ["m1", "user", "Fix the order form"],
      ["activity:t1", "activity", "Ran 2 commands, edited 1 file"],
      ["m2", "assistant", "Looking at it."],
      ["m3", "assistant", "Fixed: the button was disabled."],
    ]);
  });

  it("starts with the last 200 messages", () => {
    const many = Array.from({ length: 250 }, (_, index) => message(`m${index}`, "user", `hi ${index}`));
    const events = snapshotEvents(many, new Map());
    expect(events).toHaveLength(200);
    expect(events[0]!.messageId).toBe("m50");
  });

  it("never carries a tool's words, only counts", () => {
    expect(activityLine(NO_TOOLS)).toBeNull();
    expect(activityLine({ commands: 1, edits: 0, other: 3 })).toBe("Ran 1 command, used 3 tools");
    expect(activityLine({ commands: 0, edits: 2, other: 0 })).toBe("Edited 2 files");
  });

  it("cuts a long message to the server's limit", () => {
    const text = clipText("x".repeat(20_000));
    expect(text).toHaveLength(16_000);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("what goes after a restart", () => {
  const events: ReadonlyArray<MirrorEvent> = [
    { messageId: "a", role: "user", text: "one", at },
    { messageId: "b", role: "assistant", text: "two", at },
  ];

  it("only what changed since it was sent", () => {
    const sent = rememberSent({}, events);
    expect(unsent(events, sent)).toEqual([]);
    const changed = [events[0]!, { ...events[1]!, text: "two, longer" }];
    expect(unsent(changed, sent).map((event) => event.messageId)).toEqual(["b"]);
  });

  it("remembers at most so many, the oldest dropped", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      messageId: `m${index}`,
      role: "user" as const,
      text: `${index}`,
      at,
    }));
    const sent = rememberSent({}, many, 4);
    expect(Object.keys(sent)).toEqual(["m6", "m7", "m8", "m9"]);
    expect(sent["m9"]).toBe(eventHash(many[9]!));
  });
});

describe("batches", () => {
  it("at most 100 events each, in order", () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      messageId: `m${index}`,
      role: "user" as const,
      text: "hi",
      at,
    }));
    const out = batches(many);
    expect(out.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(out[2]![49]!.messageId).toBe("m249");
  });

  it("at most 1 MB each, an event never split", () => {
    const big = Array.from({ length: 5 }, (_, index) => ({
      messageId: `m${index}`,
      role: "assistant" as const,
      text: "x".repeat(16_000),
      at,
    }));
    expect(batches(big, 100, 40_000).map((batch) => batch.length)).toEqual([2, 2, 1]);
  });
});

describe("the chat's state and its streaming text", () => {
  it("running, waiting for the person, or idle", () => {
    expect(threadStatusOf({ session: { status: "running" } })).toBe("running");
    expect(threadStatusOf({ session: { status: "ready", activeTurnId: "t1" } })).toBe("running");
    expect(threadStatusOf({ session: { status: "running" }, hasPendingApprovals: true })).toBe(
      "waiting",
    );
    expect(threadStatusOf({ session: { status: "ready", activeTurnId: null } })).toBe("idle");
    expect(threadStatusOf({ session: null })).toBe("idle");
  });

  it("a streaming message goes at most every 2 s", () => {
    let step = onStreamDelta(undefined, "Hel", 1_000);
    expect(step).toEqual({ state: { text: "Hel", lastSentAt: 1_000 }, send: true });
    step = onStreamDelta(step.state, "lo", 1_500);
    expect(step).toEqual({ state: { text: "Hello", lastSentAt: 1_000 }, send: false });
    step = onStreamDelta(step.state, "!", 1_000 + STREAM_EVERY_MS);
    expect(step).toEqual({ state: { text: "Hello!", lastSentAt: 3_000 }, send: true });
  });

  it("waits longer after each failure, up to 5 minutes", () => {
    expect([1, 2, 3, 20].map(backoffMs)).toEqual([2_000, 4_000, 8_000, 300_000]);
  });
});
