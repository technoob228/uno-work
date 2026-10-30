import { describe, expect, it } from "vitest";

import { largeFileCloudDeps, largeFileText } from "./largeFileLink.ts";

describe("largeFileText", () => {
  const base = {
    name: "видео.mp4",
    sizeBytes: 80 * 1024 * 1024,
    chat: "Telegram" as const,
    moreUrl: "https://app.uno4.work",
  };

  it("gives one line with the link as a word", () => {
    const text = largeFileText({ ...base, language: "ru", url: "https://d/x" });
    expect(text).toBe(
      "«видео.mp4» (80 МБ) не влезает в Telegram: [скачать](https://d/x), ссылка работает 7 дней.",
    );
    expect(text).not.toContain("\n");
  });

  it("says where the file is when no link could be made", () => {
    expect(largeFileText({ ...base, language: "en", url: null })).toContain(
      "it waits in Uno Work: https://app.uno4.work",
    );
  });
});

describe("largeFileCloudDeps", () => {
  it("prefers the computer's token and needs one", () => {
    const uno = { boxToken: " box ", apiKey: "key" };
    expect(largeFileCloudDeps({ uno } as never)).toEqual({ token: "box" });
    expect(largeFileCloudDeps({ uno: { apiKey: " " } } as never)).toBeNull();
  });
});
