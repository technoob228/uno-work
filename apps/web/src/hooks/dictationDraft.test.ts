import { describe, expect, it } from "vitest";

import { dictationErrorMessage, resolveDictationInsert } from "./dictationDraft";

describe("resolveDictationInsert", () => {
  const draft = (text: string, cursor = text.length, owner = "chat-a") => ({ owner, text, cursor });

  it("puts the words at the caret they were recorded at", () => {
    expect(resolveDictationInsert(draft("Fix  please", 4), draft("Fix  please", 4), "the bug")).toEqual(
      { kind: "insert", at: 4, insertion: "the bug" },
    );
    expect(resolveDictationInsert(draft("Hello"), draft("Hello"), " world ")).toEqual({
      kind: "insert",
      at: 5,
      insertion: " world",
    });
  });

  it("adds a space after when the caret sits before a word", () => {
    expect(resolveDictationInsert(draft("please", 0), draft("please", 0), "Fix it")).toEqual({
      kind: "insert",
      at: 0,
      insertion: "Fix it ",
    });
  });

  it("never splits what the person typed while it transcribed: the words go at the end", () => {
    expect(
      resolveDictationInsert(draft("Make a report", 5), draft("Make a sales report", 2), "for May"),
    ).toEqual({ kind: "insert", at: "Make a sales report".length, insertion: " for May" });
  });

  it("keeps the words out of another chat", () => {
    expect(
      resolveDictationInsert(draft("", 0, "chat-a"), draft("", 0, "chat-b"), "hello"),
    ).toEqual({ kind: "elsewhere" });
    expect(resolveDictationInsert(draft(""), null, "hello")).toEqual({ kind: "elsewhere" });
  });

  it("ignores an empty transcript", () => {
    expect(resolveDictationInsert(draft(""), draft(""), "   ")).toEqual({ kind: "empty" });
  });
});

describe("dictationErrorMessage", () => {
  it("says what to check when nothing was heard", () => {
    expect(
      dictationErrorMessage("Transcription failed: transcription response contained no text"),
    ).toBe("Didn't hear anything — check microphone access");
    expect(dictationErrorMessage("No speech was recognized.")).toBe(
      "Didn't hear anything — check microphone access",
    );
  });

  it("keeps the gateway's own sentence", () => {
    expect(dictationErrorMessage("You've used today's free dictation.")).toBe(
      "You've used today's free dictation.",
    );
  });
});
