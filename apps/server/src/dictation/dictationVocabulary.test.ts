import { describe, expect, it } from "vitest";

import {
  buildCleanupMessages,
  buildDictationGlossary,
  parseVocabularyTerms,
  sanitizeCleanupText,
  STATIC_DICTATION_TERMS,
} from "./dictationVocabulary.ts";

describe("parseVocabularyTerms", () => {
  it("splits on commas, semicolons and newlines and drops blanks", () => {
    expect(parseVocabularyTerms("fishcode, ворктри;\n\n uno-api \n")).toEqual([
      "fishcode",
      "ворктри",
      "uno-api",
    ]);
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    expect(parseVocabularyTerms("Codex, codex, CODEX")).toEqual(["Codex"]);
  });

  it("ignores absurdly long entries so a pasted paragraph cannot flood the prompt", () => {
    expect(parseVocabularyTerms(`ok, ${"x".repeat(200)}`)).toEqual(["ok"]);
  });
});

describe("buildDictationGlossary", () => {
  it("puts user terms first and always appends the static vocabulary", () => {
    const glossary = buildDictationGlossary({
      userTerms: ["fishcode"],
      contextTerms: ["feat/composer-dictation"],
      projectTerms: ["uno-work-app"],
    });
    expect(glossary.slice(0, 3)).toEqual(["fishcode", "feat/composer-dictation", "uno-work-app"]);
    expect(glossary).toContain(STATIC_DICTATION_TERMS[0]);
  });

  it("caps the glossary length", () => {
    const many = Array.from({ length: 500 }, (_, index) => `term-${index}`);
    expect(buildDictationGlossary({ userTerms: many }).length).toBeLessThanOrEqual(96);
  });
});

describe("buildCleanupMessages", () => {
  it("forbids translation when the language is auto", () => {
    const [system] = buildCleanupMessages({
      transcript: "привет",
      glossary: [],
      language: "auto",
    });
    expect(system?.content).toContain("Never translate");
  });

  it("asks to restore the pinned language when the model translated the take", () => {
    const [system] = buildCleanupMessages({ transcript: "hello", glossary: [], language: "ru" });
    expect(system?.content).toContain('restore it to "ru"');
  });

  it("carries the glossary and project name in the user message", () => {
    const [, user] = buildCleanupMessages({
      transcript: "открой ворктри",
      glossary: ["worktree"],
      language: "ru",
      projectName: "uno-work-app",
    });
    expect(user?.content).toContain("Project: uno-work-app");
    expect(user?.content).toContain("worktree");
    expect(user?.content).toContain("открой ворктри");
  });
});

describe("sanitizeCleanupText", () => {
  it("unwraps fenced and quoted responses", () => {
    expect(sanitizeCleanupText("```\nоткрой worktree\n```", "открой ворктри")).toBe(
      "открой worktree",
    );
    expect(sanitizeCleanupText('"открой worktree"', "открой ворктри")).toBe("открой worktree");
  });

  it("rejects a response that answered instead of editing", () => {
    expect(
      sanitizeCleanupText("Sure! Here is a long explanation ".repeat(10), "открой"),
    ).toBeNull();
  });

  it("rejects empty output", () => {
    expect(sanitizeCleanupText("   ", "открой")).toBeNull();
  });
});
