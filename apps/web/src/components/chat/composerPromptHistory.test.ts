import { describe, expect, it } from "vitest";

import {
  buildComposerPromptHistoryEntries,
  isCaretOnPromptEdge,
  recallableComposerPrompt,
  stepComposerPromptHistory,
} from "./composerPromptHistory";

const user = (id: string, text: string, sentByThreadId?: string) => ({
  id,
  role: "user",
  text,
  ...(sentByThreadId ? { sentByThreadId } : {}),
});

describe("recallableComposerPrompt", () => {
  it("drops the terminal context the app appended", () => {
    expect(
      recallableComposerPrompt(
        "fix the build\n\n<terminal_context>\n- Terminal 1 lines 1-2:\n  1 | npm run build\n</terminal_context>",
      ),
    ).toBe("fix the build");
  });

  it("skips app-composed sends", () => {
    expect(
      recallableComposerPrompt(
        "[User attached one or more files or images without additional text. Respond using the conversation context and the attachment(s).]",
      ),
    ).toBe("");
    expect(recallableComposerPrompt("PLEASE IMPLEMENT THIS PLAN:\n1. do it")).toBe("");
  });
});

describe("buildComposerPromptHistoryEntries", () => {
  it("keeps the person's own messages, oldest first, without repeats in a row", () => {
    const entries = buildComposerPromptHistoryEntries([
      user("1", "hello"),
      { id: "2", role: "assistant", text: "hi" },
      user("3", "run tests"),
      user("4", "run tests"),
      user("5", "from another chat", "thread-x"),
      user("6", "   "),
    ]);
    expect(entries).toEqual([
      { id: "1", prompt: "hello" },
      { id: "4", prompt: "run tests" },
    ]);
  });
});

describe("stepComposerPromptHistory", () => {
  const entries = [
    { id: "1", prompt: "first" },
    { id: "2", prompt: "second" },
  ];

  it("↑ from an empty box brings the newest, then older, and stops at the oldest", () => {
    const newest = stepComposerPromptHistory({
      direction: "backward",
      entries,
      position: null,
      currentPrompt: "",
    });
    expect(newest?.prompt).toBe("second");
    const older = stepComposerPromptHistory({
      direction: "backward",
      entries,
      position: newest!.position,
      currentPrompt: "second",
    });
    expect(older?.prompt).toBe("first");
    expect(
      stepComposerPromptHistory({
        direction: "backward",
        entries,
        position: older!.position,
        currentPrompt: "first",
      }),
    ).toBeNull();
  });

  it("↓ past the newest empties the box", () => {
    expect(
      stepComposerPromptHistory({
        direction: "forward",
        entries,
        position: { entryId: "2", recalled: "second" },
        currentPrompt: "second",
      }),
    ).toEqual({ position: null, prompt: "" });
  });

  it("never replaces a typed or edited draft", () => {
    expect(
      stepComposerPromptHistory({
        direction: "backward",
        entries,
        position: null,
        currentPrompt: "my draft",
      }),
    ).toBeNull();
    expect(
      stepComposerPromptHistory({
        direction: "forward",
        entries,
        position: { entryId: "2", recalled: "second" },
        currentPrompt: "second, edited",
      }),
    ).toBeNull();
  });
});

describe("isCaretOnPromptEdge", () => {
  it("browses from the first line with ↑ and the last line with ↓", () => {
    const prompt = "line one\nline two";
    expect(isCaretOnPromptEdge(prompt, 3, "start")).toBe(true);
    expect(isCaretOnPromptEdge(prompt, 12, "start")).toBe(false);
    expect(isCaretOnPromptEdge(prompt, 12, "end")).toBe(true);
    expect(isCaretOnPromptEdge(prompt, 3, "end")).toBe(false);
    expect(isCaretOnPromptEdge("", 0, "start")).toBe(true);
  });
});
