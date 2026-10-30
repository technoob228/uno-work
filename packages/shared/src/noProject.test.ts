import { describe, expect, it } from "vitest";

import { chatFolderName, chatFolderWords, isNoProjectRoot, noProjectRoot } from "./noProject.ts";

describe("no project", () => {
  it("lives in one folder of the home folder", () => {
    expect(noProjectRoot("/home/uno")).toBe("/home/uno/chats");
    expect(noProjectRoot("/home/uno/")).toBe("/home/uno/chats");
    expect(isNoProjectRoot("/home/uno/chats/", "/home/uno")).toBe(true);
    expect(isNoProjectRoot("/home/uno/chats/one", "/home/uno")).toBe(false);
    expect(isNoProjectRoot("/home/uno", "/home/uno")).toBe(false);
  });

  it("names a chat's folder by the day, its first words and its id", () => {
    expect(
      chatFolderName({
        date: "2026-10-30",
        text: "Convert these PNGs to WebP, please and thanks",
        threadId: "11111111-2222-3333-4444-a1b2c3d4e5f6",
      }),
    ).toBe("2026-10-30-convert-these-pngs-to-webp-c3d4e5f6");
  });

  it("does without words a folder name can't carry", () => {
    expect(chatFolderWords("Сконвертируй картинки")).toBe("");
    expect(chatFolderName({ date: "2026-10-30", text: "Привет", threadId: "abc-123" })).toBe(
      "2026-10-30-abc123",
    );
    expect(chatFolderWords("../../etc/passwd")).toBe("etc-passwd");
  });

  it("takes another name when one is taken", () => {
    expect(chatFolderName({ date: "2026-10-30", text: "", threadId: "abc", extra: "2" })).toBe(
      "2026-10-30-abc-2",
    );
  });
});
