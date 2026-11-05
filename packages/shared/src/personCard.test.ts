import { describe, expect, it } from "vitest";

import { personCardToMarkdown, validatePersonCard } from "./personCard.ts";

describe("validatePersonCard", () => {
  it("reads a choice with string options and a quiz with a single correct number", () => {
    const choice = validatePersonCard({
      kind: "choice",
      question: "Deploy?",
      options: ["Yes", "No"],
    });
    expect(choice).toEqual({
      ok: true,
      card: { kind: "choice", question: "Deploy?", options: [{ label: "Yes" }, { label: "No" }] },
    });
    const quiz = validatePersonCard({
      kind: "quiz",
      questions: [{ question: "2+2?", options: ["3", "4"], correct: 1 }],
    });
    expect(quiz.ok && quiz.card.kind === "quiz" && quiz.card.questions[0]?.correct).toEqual([1]);
  });

  it("explains how to fix a bad call", () => {
    expect(validatePersonCard({ kind: "poll" })).toMatchObject({ ok: false });
    const outOfRange = validatePersonCard({
      kind: "quiz",
      questions: [{ question: "?", options: ["a", "b"], correct: [2] }],
    });
    expect(outOfRange).toMatchObject({ ok: false, error: expect.stringContaining("0 to 1") });
    const table = validatePersonCard({
      kind: "report",
      title: "T",
      sections: [{ table: { columns: ["a", "b"], rows: [["1"]] } }],
    });
    expect(table).toMatchObject({ ok: false, error: expect.stringContaining("one per column") });
  });

  // Seen on uno/fast 05.11: GLM's tool format leaked into the kind string.
  it("repairs arguments a fast model leaked into a string", () => {
    const result = validatePersonCard({
      kind: "choice<arg_key>multiple</arg_key><arg_value>true",
      question: "What to delete?",
      options: [{ label: "video.mov" }, { label: "cache" }],
    });
    expect(result).toMatchObject({ ok: true, card: { kind: "choice", multiple: true } });
  });

  it("guesses the kind a weak model forgot", () => {
    expect(
      validatePersonCard({ question: "When?", options: [{ label: "9:00" }, { label: "18:00" }] }),
    ).toMatchObject({ ok: true, card: { kind: "choice" } });
    expect(
      validatePersonCard({ questions: [{ question: "?", options: ["a", "b"], correct: [0] }] }),
    ).toMatchObject({ ok: true, card: { kind: "quiz" } });
    expect(validatePersonCard({ title: "Done", summary: "All good" })).toMatchObject({
      ok: true,
      card: { kind: "report" },
    });
    expect(validatePersonCard({ text: "hi" })).toMatchObject({ ok: false });
  });
});

describe("personCardToMarkdown", () => {
  it("keeps tables and next steps in the plain fallback", () => {
    const result = validatePersonCard({
      kind: "report",
      title: "Sales",
      sections: [{ table: { columns: ["Item", "Orders"], rows: [["Latte", "61"]] } }],
      actions: ["Export CSV"],
    });
    if (!result.ok) throw new Error(result.error);
    const text = personCardToMarkdown(result.card);
    expect(text).toContain("| Latte | 61 |");
    expect(text).toContain("Next: Export CSV");
  });
});
