import { describe, expect, it } from "vitest";

import { formatDictationDuration, insertDictatedText } from "./dictationText";

describe("insertDictatedText", () => {
  it("inserts into an empty composer without padding", () => {
    expect(insertDictatedText({ value: "", cursor: 0, transcript: " почини сборку " })).toEqual({
      insertion: "почини сборку",
      text: "почини сборку",
      cursor: 13,
    });
  });

  it("adds a separating space after existing text", () => {
    const result = insertDictatedText({
      value: "сначала",
      cursor: 7,
      transcript: "потом",
    });
    expect(result.text).toBe("сначала потом");
    expect(result.cursor).toBe(13);
  });

  it("does not double the space the user already typed", () => {
    expect(insertDictatedText({ value: "fix ", cursor: 4, transcript: "the build" }).text).toBe(
      "fix the build",
    );
  });

  it("pads only where needed when inserting mid-sentence", () => {
    const result = insertDictatedText({ value: "aa bb", cursor: 2, transcript: "xx" });
    expect(result.text).toBe("aa xx bb");
  });

  it("skips the trailing space before punctuation", () => {
    expect(insertDictatedText({ value: "run.", cursor: 3, transcript: "tests" }).text).toBe(
      "run tests.",
    );
  });

  it("is a no-op for a blank transcript", () => {
    expect(insertDictatedText({ value: "keep", cursor: 2, transcript: "   " })).toEqual({
      insertion: "",
      text: "keep",
      cursor: 2,
    });
  });

  it("clamps an out-of-range cursor instead of dropping text", () => {
    expect(insertDictatedText({ value: "abc", cursor: 99, transcript: "d" }).text).toBe("abc d");
  });
});

describe("formatDictationDuration", () => {
  it("formats as m:ss", () => {
    expect(formatDictationDuration(0)).toBe("0:00");
    expect(formatDictationDuration(9_400)).toBe("0:09");
    expect(formatDictationDuration(75_000)).toBe("1:15");
  });
});
