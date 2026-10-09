import { describe, expect, it } from "@effect/vitest";

import {
  detectReplyLanguage,
  progressNoteDueAfterMs,
  progressNoteText,
  splitReplyText,
} from "./connectorReplyText.ts";

const words = (text: string) =>
  text.split(/\s+/).filter((word) => word.length > 0 && !word.startsWith("```"));

describe("splitReplyText", () => {
  it("keeps a short reply whole", () => {
    expect(splitReplyText("  hello  ", 4000)).toEqual(["hello"]);
    expect(splitReplyText("   ", 4000)).toEqual([]);
  });

  it("splits a long reply into parts under the limit without losing a word", () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, index) => `Paragraph ${index}: ` + "lorem ipsum dolor sit amet ".repeat(12),
    );
    const text = paragraphs.join("\n\n");
    const parts = splitReplyText(text, 1000);
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(1000);
    expect(words(parts.join("\n"))).toEqual(words(text));
    // Paragraph boundaries are preferred: no part starts mid-paragraph.
    for (const part of parts) expect(part.startsWith("Paragraph")).toBe(true);
  });

  it("hard-cuts text without any break, never splitting a surrogate pair", () => {
    const text = "😀".repeat(3000);
    const parts = splitReplyText(text, 1001);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(1001);
      expect(part).not.toMatch(/[\ud800-\udbff]$/);
    }
    expect(parts.join("")).toBe(text);
  });

  it("keeps fenced code blocks balanced across parts", () => {
    const code = Array.from({ length: 200 }, (_, index) => `const line${index} = ${index};`);
    const text = ["Here is the file:", "```ts", ...code, "```", "That's all."].join("\n");
    const parts = splitReplyText(text, 1500);
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(1500);
      const fences = part.split("\n").filter((line) => line.startsWith("```")).length;
      expect(fences % 2).toBe(0);
    }
    expect(words(parts.join("\n"))).toEqual(words(text));
    expect(parts.slice(1, -1).every((part) => part.startsWith("```ts\n"))).toBe(true);
  });
});

describe("detectReplyLanguage", () => {
  it("follows the script of the message, then the client language", () => {
    expect(detectReplyLanguage("почему у коллеги не получается", "en")).toBe("ru");
    expect(detectReplyLanguage("why is notetaker not installed", "ru")).toBe("en");
    expect(detectReplyLanguage("🙂", "ru")).toBe("ru");
    expect(detectReplyLanguage("", null)).toBe("en");
  });
});

describe("progress notes", () => {
  it("never says 'check the app' and speaks the person's language", () => {
    const ru = progressNoteText({ language: "ru", elapsedMs: 3 * 60_000, first: true });
    const en = progressNoteText({ language: "en", elapsedMs: 21 * 60_000, first: false });
    expect(ru).toBe(
      "Работаю над этим уже 3 минуты — задача долгая. Ответ пришлю сюда, как закончу.",
    );
    expect(en).toBe("Still working on it (21 minutes). The answer will come here.");
    expect(progressNoteText({ language: "ru", elapsedMs: 2.5 * 3600_000, first: false })).toBe(
      "Всё ещё работаю (2,5 ч). Ответ пришлю сюда.",
    );
    for (const text of [ru, en]) expect(text.toLowerCase()).not.toContain("check the app");
  });

  it("spaces notes out ever more", () => {
    const due = [0, 1, 2, 3, 4, 5].map(progressNoteDueAfterMs);
    expect(due).toEqual([180_000, 900_000, 2_700_000, 7_200_000, 14_400_000, 21_600_000]);
  });
});
