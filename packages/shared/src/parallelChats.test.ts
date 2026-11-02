import { describe, expect, it } from "vitest";

import {
  parallelChatsLine,
  parallelResolveNoteBody,
  readParallelChatsLine,
} from "./parallelChats.ts";
import { parseUnoWorkNote, UNO_WORK_NOTE_PREFIX } from "./secretRequestCopy.ts";

describe("parallel chats words", () => {
  it("the combine turn shows as one quiet line", () => {
    const text = `${UNO_WORK_NOTE_PREFIX}${parallelResolveNoteBody({
      files: ["config.json"],
      otherTitle: "Price 10",
      ownTitle: "Price 20",
    })}`;
    expect(parseUnoWorkNote(text)).toEqual({
      kind: "parallel-chats",
      text: "Combining with another chat's changes…",
    });
    expect(text).toContain("Files to fix: config.json");
  });

  it("lines say nothing about branches, merges or copies", () => {
    for (const line of ["joined", "waiting", "parked"] as const) {
      expect(parallelChatsLine({ line })).not.toMatch(/branch|merge|copy|conflict/i);
    }
    expect(parallelChatsLine({ line: "kept-both", files: ["logo.png", "a.bin"] })).toBe(
      "logo.png and 1 more changed in two chats. Both versions are kept. Tell this chat which one to use.",
    );
    expect(readParallelChatsLine({ line: "nope" })).toBeNull();
    expect(readParallelChatsLine({ line: "waiting" })).toEqual({ line: "waiting" });
  });
});
