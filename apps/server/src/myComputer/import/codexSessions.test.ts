import { describe, expect, it } from "vitest";

import { codexSession } from "./fakeComputer.testkit.ts";
import { parseCodexHistory, parseCodexIndex, peekCodexSession } from "./codexSessions.ts";
import type { PeekResult, SessionPeek } from "./sessionText.ts";

const whole = (text: string): SessionPeek => ({ head: text, tail: null, headCut: false });
const chat = (result: PeekResult) => {
  if (result.kind !== "chat") throw new Error(`expected a chat, got ${result.kind}`);
  return result;
};

describe("peekCodexSession", () => {
  it("names a chat by the person's first words, past what Codex injects", () => {
    const result = chat(peekCodexSession(whole(codexSession({}))));
    expect(result.title).toBe("Write the release notes");
    expect(result.cwd).toBe("/Users/test/projects/beta");
    expect(result.startedAt).toBe("2026-10-29T10:00:00.000Z");
  });

  it("reads the folder from a session_meta longer than the head", () => {
    const text = codexSession({ instructions: "y".repeat(100_000) });
    const moved = text
      .replace(/"cwd":"[^"]*",/, "")
      .replace('"id":', '"cwd":"/Users/test/projects/long","id":');
    const result = chat(
      peekCodexSession({ head: moved.slice(0, 60_000), tail: null, headCut: true }),
    );
    expect(result.cwd).toBe("/Users/test/projects/long");
    expect(result.title).toBeNull();
  });

  it("leaves out sessions Codex started for itself", () => {
    expect(peekCodexSession(whole(codexSession({ source: "subagent" }))).kind).toBe("not-a-chat");
    expect(
      peekCodexSession(whole(codexSession({ source: { subagent: { review: {} } } }))).kind,
    ).toBe("not-a-chat");
    expect(peekCodexSession(whole(codexSession({ source: "cli" }))).kind).toBe("chat");
  });

  it("does not take a session without a turn for a chat", () => {
    const meta = `${codexSession({}).split("\n")[0]}\n`;
    expect(peekCodexSession(whole(meta)).kind).toBe("not-a-chat");
  });

  it("tells a broken file from one it doesn't know", () => {
    expect(peekCodexSession(whole("garbage")).kind).toBe("broken");
    expect(peekCodexSession(whole('{"format":"from the future"}\n')).kind).toBe("unknown-format");
  });
});

describe("parseCodexHistory", () => {
  it("keeps the conversation once, without the injected turns", () => {
    expect(
      parseCodexHistory(codexSession({})).map((message) => [message.role, message.text]),
    ).toEqual([
      ["user", "Write the release notes"],
      ["assistant", "Here they are."],
    ]);
  });

  it("falls back to events when a version writes no response items", () => {
    const events = [
      { type: "user_message", message: "Old style question" },
      { type: "agent_message", message: "Old style answer" },
    ]
      .map((payload) =>
        JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", type: "event_msg", payload }),
      )
      .join("\n");
    expect(parseCodexHistory(events).map((message) => message.text)).toEqual([
      "Old style question",
      "Old style answer",
    ]);
  });
});

describe("parseCodexIndex", () => {
  it("takes the latest name of each thread", () => {
    const names = parseCodexIndex(
      [
        JSON.stringify({ id: "a", thread_name: "First" }),
        JSON.stringify({ id: "a", thread_name: "Second" }),
        "broken",
      ].join("\n"),
    );
    expect(names.get("a")).toBe("Second");
  });
});
