import { describe, expect, it } from "vitest";

import { claudeSession } from "./fakeComputer.testkit.ts";
import { parseClaudeHistory, peekClaudeSession } from "./claudeSessions.ts";
import type { PeekResult, SessionPeek } from "./sessionText.ts";

const whole = (text: string): SessionPeek => ({ head: text, tail: null, headCut: false });
const chat = (result: PeekResult) => {
  if (result.kind !== "chat") throw new Error(`expected a chat, got ${result.kind}`);
  return result;
};

describe("peekClaudeSession", () => {
  it("names a chat by its first prompt and takes the folder and times", () => {
    const result = chat(peekClaudeSession(whole(claudeSession({}))));
    expect(result.title).toBe("Fix the login page");
    expect(result.cwd).toBe("/Users/test/projects/alpha");
    expect(result.startedAt).toBe("2026-10-29T10:00:00.000Z");
  });

  it("prefers the title the person gave, then Claude's own", () => {
    const named = claudeSession({
      extra: [
        { type: "ai-title", aiTitle: "Login page fix", sessionId: "s" },
        { type: "custom-title", customTitle: "My login work", sessionId: "s" },
      ],
    });
    expect(chat(peekClaudeSession(whole(named))).title).toBe("My login work");
    const ai = claudeSession({ extra: [{ type: "ai-title", aiTitle: "Login page fix" }] });
    expect(chat(peekClaudeSession(whole(ai))).title).toBe("Login page fix");
  });

  it("skips what Claude Code itself put into the first turn", () => {
    const text = claudeSession({
      prompt: "<system-reminder>be nice</system-reminder>",
      extra: [],
    }).replace('"type":"attachment"', '"type":"attachment","note":"-"');
    const withReal = `${text}${JSON.stringify({
      type: "user",
      uuid: "u2",
      sessionId: "s",
      timestamp: "2026-10-29T10:01:00.000Z",
      message: { role: "user", content: "The real question" },
    })}\n`;
    expect(chat(peekClaudeSession(whole(withReal))).title).toBe("The real question");
  });

  it("reads a slash command as its name", () => {
    const text = claudeSession({
      prompt: "<command-name>/compact</command-name><command-args></command-args>",
    });
    expect(chat(peekClaudeSession(whole(text))).title).toBe("/compact");
  });

  it("still names a chat whose first line doesn't fit the head", () => {
    const pasted = `Explain this log: ${"x".repeat(100_000)}`;
    const text = claudeSession({ prompt: pasted });
    const head = text.slice(text.indexOf('{"sessionId"'), 60_000);
    const result = chat(peekClaudeSession({ head, tail: null, headCut: true }));
    expect(result.title).toMatch(/^Explain this log: x+\.\.\.$/);
    expect(result.title!.length).toBeLessThanOrEqual(120);
  });

  it("takes the latest title and time from the tail of a big file", () => {
    const text = claudeSession({});
    const tail = `cut line\n${JSON.stringify({
      type: "custom-title",
      customTitle: "Renamed later",
      sessionId: "s",
    })}\n${JSON.stringify({
      type: "user",
      uuid: "u9",
      sessionId: "s",
      timestamp: "2026-10-30T09:00:00.000Z",
      message: { role: "user", content: "Later" },
    })}\n`;
    const result = chat(peekClaudeSession({ head: `${text}{"cut`, tail, headCut: true }));
    expect(result.title).toBe("Renamed later");
    expect(result.lastActiveAt).toBe("2026-10-30T09:00:00.000Z");
  });

  it("does not take a sub-agent's session or an empty one for a chat", () => {
    const sidechain = `${JSON.stringify({ type: "user", isSidechain: true, sessionId: "s" })}\n`;
    expect(peekClaudeSession(whole(sidechain)).kind).toBe("not-a-chat");
    const empty = `${JSON.stringify({ type: "queue-operation", sessionId: "s" })}\n`;
    expect(peekClaudeSession(whole(empty)).kind).toBe("not-a-chat");
  });

  it("tells a broken file from one it doesn't know", () => {
    expect(peekClaudeSession(whole("\u0000\u0001 not json at all")).kind).toBe("broken");
    expect(peekClaudeSession(whole('{"hello":"world"}\n')).kind).toBe("unknown-format");
  });
});

describe("parseClaudeHistory", () => {
  it("keeps what the person and the assistant said, and nothing else", () => {
    const toolTurn = {
      parentUuid: "r1",
      type: "user",
      uuid: "t1",
      timestamp: "2026-10-29T10:00:05.000Z",
      message: { content: [{ type: "tool_result", content: "secret file contents" }] },
    };
    const messages = parseClaudeHistory(claudeSession({ extra: [toolTurn] }));
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Fix the login page"],
      ["assistant", "Done."],
    ]);
  });

  it("joins one assistant message written over several lines", () => {
    const part = (uuid: string, parentUuid: string, text: string) => ({
      type: "assistant",
      uuid,
      parentUuid,
      timestamp: "2026-10-29T10:00:01.000Z",
      message: { id: "msg_2", content: [{ type: "text", text }] },
    });
    const messages = parseClaudeHistory(
      claudeSession({ extra: [part("p1", "r1", "First."), part("p2", "p1", "Second.")] }),
    );
    expect(messages.at(-1)?.text).toBe("First.\n\nSecond.");
    expect(messages).toHaveLength(3);
  });

  it("shows the branch the person ended on, not the rewound one", () => {
    const rewound = {
      type: "user",
      uuid: "dead",
      parentUuid: "u1",
      timestamp: "2026-10-29T10:00:02.000Z",
      message: { content: "An abandoned idea" },
    };
    const kept = {
      type: "user",
      uuid: "live",
      parentUuid: "u1",
      timestamp: "2026-10-29T10:00:03.000Z",
      message: { content: "The way it went" },
    };
    const texts = parseClaudeHistory(claudeSession({ extra: [rewound, kept] })).map(
      (message) => message.text,
    );
    expect(texts).toContain("The way it went");
    expect(texts).not.toContain("An abandoned idea");
  });

  it("crosses a compaction and falls back to file order for a broken chain", () => {
    const boundary = {
      type: "system",
      uuid: "b1",
      parentUuid: null,
      logicalParentUuid: "r1",
      timestamp: "2026-10-29T11:00:00.000Z",
    };
    const after = {
      type: "user",
      uuid: "u5",
      parentUuid: "b1",
      timestamp: "2026-10-29T11:00:01.000Z",
      message: { content: "After the compaction" },
    };
    const crossed = parseClaudeHistory(claudeSession({ extra: [boundary, after] }));
    expect(crossed.map((message) => message.text)).toEqual([
      "Fix the login page",
      "Done.",
      "After the compaction",
    ]);

    const orphan = { ...after, parentUuid: "lost" };
    const linear = parseClaudeHistory(claudeSession({ extra: [orphan] }));
    expect(linear.map((message) => message.text)).toContain("Fix the login page");
    expect(linear.map((message) => message.text)).toContain("After the compaction");
  });

  it("skips broken lines instead of failing", () => {
    expect(parseClaudeHistory(`not json\n${claudeSession({})}{"cut`)).toHaveLength(2);
  });
});
