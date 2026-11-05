import { validatePersonCard, type PersonCard } from "@t3tools/shared/personCard";
import { describe, expect, it } from "vitest";

import {
  buildInlineKeyboard,
  decodeButtonsState,
  EMPTY_BUTTONS_STATE,
  pickedLabels,
  pickedValues,
  pruneButtonsState,
  toggleGroupPick,
  type ButtonGroup,
  type ConnectorButtonsState,
} from "./connectorButtons.ts";
import {
  answerQuiz,
  cardButtons,
  cardPlainText,
  cardRichMarkdown,
  escapeRichText,
  findQuizByPoll,
  idleQuizzes,
  newCardQuiz,
  pickedMessage,
  putQuiz,
  QUIZ_IDLE_MS,
  quizIntroText,
  quizPollParams,
  quizSummaryText,
  removeQuiz,
  richMediaField,
  safeRichMarkdown,
} from "./telegramRichCard.ts";

const card = (input: unknown): PersonCard => {
  const checked = validatePersonCard(input);
  if (!checked.ok) throw new Error(checked.error);
  return checked.card;
};

const choice = card({
  kind: "choice",
  title: "Plan",
  question: "Which plan?",
  options: [
    { label: "Small", description: "$5, one bot" },
    { label: "Plus", recommended: true, prompt: "Take Plus" },
  ],
});

const multiple = card({
  kind: "choice",
  question: "Which languages?",
  options: ["Python", "Go", "Rust"],
  multiple: true,
  allowOther: true,
});

const quizCard = card({
  kind: "quiz",
  title: "Capitals",
  questions: [
    {
      question: "Capital of France?",
      options: ["Lyon", "Paris"],
      correct: 1,
      explanation: "Since 508.",
    },
    { question: "Pick the even ones", options: ["1", "2", "4"], correct: [1, 2] },
  ],
});

const report = card({
  kind: "report",
  title: "Site checked",
  summary: "2 problems, costs $40 to $50",
  metrics: [
    { label: "Speed", value: "92/100", tone: "good" },
    { label: "Errors", value: "2", tone: "bad", note: "both easy" },
  ],
  sections: [
    { heading: "Problems", markdown: "- No favicon\n- Hero costs $40 and $50 `$x`" },
    {
      table: {
        columns: ["Page", "Score"],
        rows: [
          ["/", "92"],
          ["/a|b", "70"],
        ],
      },
    },
  ],
  actions: [
    { label: "Fix both", style: "success" },
    { label: "Leave it", prompt: "Leave it as is" },
  ],
});

const group = (rows: ButtonGroup["rows"]): ButtonGroup => ({
  id: "groupid1",
  connectorProjectId: "assistant",
  chatId: "42",
  messageId: 7,
  threadId: "thread-1",
  rows,
  createdAtMs: 0,
  expiresAtMs: Number.MAX_SAFE_INTEGER,
});

describe("cardButtons", () => {
  it("a choice: one button per option, the recommended one green, its prompt sent back", () => {
    const rows = cardButtons(choice as never, "en");
    expect(rows.flat().map((button) => button.label)).toEqual(["Small", "Plus"]);
    expect(rows.flat()[1]).toEqual({
      label: "Plus",
      action: { kind: "reply", value: "Take Plus" },
      style: "success",
    });
    expect(rows.flat()[0]!.action).toEqual({ kind: "reply", value: "Small" });
    // Short labels go side by side.
    expect(rows).toHaveLength(1);
  });

  it("multiple: toggles one per row and Done under them", () => {
    const rows = cardButtons(multiple as never, "en");
    expect(rows.map((row) => row.map((button) => button.label))).toEqual([
      ["Python"],
      ["Go"],
      ["Rust"],
      ["Done"],
    ]);
    expect(rows[0]![0]!.action).toEqual({ kind: "toggle", value: "Python" });
    expect(rows[3]![0]).toMatchObject({ action: { kind: "submit" }, style: "primary" });
    expect(cardButtons(multiple as never, "ru").at(-1)![0]!.label).toBe("Готово");
  });

  it("a report: its actions with their styles and prompts", () => {
    const rows = cardButtons(report as never, "en");
    expect(rows.flat()).toEqual([
      { label: "Fix both", action: { kind: "reply", value: "Fix both" }, style: "success" },
      { label: "Leave it", action: { kind: "reply", value: "Leave it as is" } },
    ]);
    expect(cardButtons(card({ kind: "report", title: "Done" }) as never, "en")).toEqual([]);
  });

  it("labels too long for a button are numbered and clipped, the list has them whole", () => {
    const long = card({
      kind: "choice",
      question: "Which?",
      options: ["A very long option label that keeps on going and going", "Short"],
    });
    const labels = cardButtons(long as never, "en")
      .flat()
      .map((button) => button.label);
    expect(labels[0]!.length).toBeLessThanOrEqual(40);
    expect(labels[0]!.startsWith("1. ")).toBe(true);
    expect(labels[1]).toBe("2. Short");
    expect(cardRichMarkdown(long as never, { header: null, language: "en" })).toContain(
      "A very long option label that keeps on going and going",
    );
  });
});

describe("the toggles of a multiple choice", () => {
  it("a press picks or unpicks; the keyboard marks the picked; Done sends them in order", () => {
    let state: ConnectorButtonsState = {
      ...EMPTY_BUTTONS_STATE,
      groups: [group(cardButtons(multiple as never, "en"))],
    };
    state = toggleGroupPick(state, "groupid1", 2).state;
    state = toggleGroupPick(state, "groupid1", 0).state;
    state = toggleGroupPick(state, "groupid1", 1).state;
    state = toggleGroupPick(state, "groupid1", 1).state;
    const picked = state.groups[0]!;
    expect(picked.picked).toEqual([0, 2]);
    const keyboard = buildInlineKeyboard(picked).inline_keyboard.flat();
    expect(keyboard.map((button) => button.text)).toEqual(["✅ Python", "Go", "✅ Rust", "Done"]);
    expect(keyboard[3]!.style).toBe("primary");
    expect(keyboard[0]!.callback_data).toBe("ub1:groupid1:0");
    expect(pickedValues(picked)).toEqual(["Python", "Rust"]);
    expect(pickedLabels(picked)).toEqual(["Python", "Rust"]);
    expect(pickedMessage(pickedValues(picked)!, "en")).toBe("Picked: Python; Rust");
    expect(pickedMessage(["Python"], "en")).toBe("Python");
  });

  it("nothing picked: Done has nothing to send", () => {
    expect(pickedValues(group(cardButtons(multiple as never, "en")))).toBeNull();
  });
});

describe("cardRichMarkdown", () => {
  it("a choice: header, title, the question, options with descriptions, the recommended marked", () => {
    const markdown = cardRichMarkdown(choice as never, {
      header: "💬 Fix the site",
      language: "en",
    });
    expect(markdown.split("\n")[0]).toBe("💬 Fix the site");
    expect(markdown).toContain("## Plan");
    expect(markdown).toContain("**Which plan?**");
    expect(markdown).toContain("1. **Small** — \\$5, one bot");
    expect(markdown).toContain("2. **Plus** ⭐ _recommended_");
  });

  it("multiple / allowOther say how to answer", () => {
    const markdown = cardRichMarkdown(multiple as never, { header: null, language: "en" });
    expect(markdown).toContain("Pick one or more, then press Done.");
    expect(markdown).toContain("Or type your own answer.");
  });

  it("a report: title, summary, metrics and section tables, pictures and documents embedded", () => {
    const markdown = cardRichMarkdown(report as never, {
      header: null,
      language: "en",
      media: [
        { id: "img1", kind: "photo", path: "/tmp/a.png", name: "a.png" },
        { id: "doc2", kind: "document", path: "/tmp/r.pdf", name: 'r"1.pdf' },
      ],
      notEmbedded: ["huge.zip"],
    });
    expect(markdown).toContain("# Site checked");
    expect(markdown).toContain("2 problems, costs \\$40 to \\$50");
    expect(markdown).toContain("| Metric | Value | Note |");
    expect(markdown).toContain("| Speed | 🟢 92/100 |   |");
    expect(markdown).toContain("| Errors | 🔴 2 | both easy |");
    expect(markdown).toContain("## Problems");
    // Section Markdown stays Markdown; a bare $ is no formula, code is untouched.
    expect(markdown).toContain("- Hero costs \\$40 and \\$50 `$x`");
    expect(markdown).toContain("| /a\\|b | 70 |");
    expect(markdown).toContain("![](tg://photo?id=img1)");
    expect(markdown).toContain(`![](tg://document?id=doc2 "r'1.pdf")`);
    expect(markdown).toContain("Files follow: huge.zip");
  });

  it("media go as attach:// parts of the same request", () => {
    expect(
      richMediaField([{ id: "img1", kind: "photo", path: "/tmp/a.png", name: "a.png" }]),
    ).toEqual([{ id: "img1", media: { type: "photo", media: "attach://img1" } }]);
  });

  it("escaping: Markdown and HTML punctuation in plain text, $ and < in the agent's Markdown", () => {
    expect(escapeRichText("a*b_c <b> $1 |x|")).toBe("a\\*b\\_c \\<b\\> \\$1 \\|x\\|");
    expect(safeRichMarkdown("**$5** <script>\n```\n$keep <x>\n```")).toBe(
      "**\\$5** \\<script>\n```\n$keep <x>\n```",
    );
  });
});

describe("the plain fallback", () => {
  it("the card as Markdown under the header, with how to answer", () => {
    const text = cardPlainText(multiple, "💬 Chat", "en");
    expect(text.startsWith("💬 Chat\n\n")).toBe(true);
    expect(text).toContain("1. Python");
    expect(text).toContain("Pick one or more, then press Done.");
    expect(cardPlainText(quizCard, null, "en")).toContain("Answer in one message, e.g.: 1A 2C");
  });
});

describe("a quiz as quiz polls", () => {
  const start = () =>
    newCardQuiz({
      id: "quiz1",
      card: quizCard as never,
      connectorProjectId: "assistant",
      chatId: "42",
      threadId: "thread-1",
      language: "en",
      nowMs: 1_000,
    });

  it("the intro names the quiz and counts the questions", () => {
    expect(quizIntroText(quizCard as never, "💬 Lessons", "en")).toBe(
      "💬 Lessons\n🧩 Capitals · 2 questions",
    );
  });

  it("each poll: non-anonymous quiz with the right answers; several right → multiple answers", () => {
    const quiz = start();
    expect(quizPollParams(quiz)).toEqual({
      question: "1/2 · Capital of France?",
      options: [{ text: "Lyon" }, { text: "Paris" }],
      is_anonymous: false,
      type: "quiz",
      correct_option_ids: [1],
      explanation: "Since 508.",
    });
    const second = quizPollParams({ ...quiz, current: 1 });
    expect(second).toMatchObject({ correct_option_ids: [1, 2], allows_multiple_answers: true });
    expect(second.explanation).toBeUndefined();
  });

  it("answers move it on; at the end ONE summary with the score and each answer", () => {
    let quiz = { ...start(), pollId: "p1" };
    let state = putQuiz(EMPTY_BUTTONS_STATE, quiz);
    expect(findQuizByPoll(state, "p1")?.id).toBe("quiz1");
    expect(answerQuiz(quiz, [], 2_000)).toEqual({ kind: "ignore" });
    const first = answerQuiz(quiz, [0], 2_000);
    expect(first.kind).toBe("next");
    if (first.kind === "ignore") throw new Error("unreachable");
    expect(first.quiz).toMatchObject({ current: 1, pollId: null, answers: [[0]], lastAtMs: 2_000 });
    quiz = { ...first.quiz, pollId: "p2" };
    state = putQuiz(state, quiz);
    expect(state.quizzes).toHaveLength(1);
    // A late answer to the first poll's question doesn't count twice.
    expect(answerQuiz({ ...quiz, current: 0 }, [1], 2_500)).toEqual({ kind: "ignore" });
    const done = answerQuiz(quiz, [2, 1], 3_000);
    expect(done.kind).toBe("done");
    if (done.kind === "ignore") throw new Error("unreachable");
    expect(quizSummaryText(done.quiz)).toBe(
      'Quiz «Capitals»: 1/2 right.\nQ1 ✗ picked "Lyon", right "Paris"\nQ2 ✓ "2", "4"',
    );
    expect(removeQuiz(state, "quiz1").quizzes).toEqual([]);
  });

  it("left half answered: its score goes after a while, said as stopped", () => {
    const answered = { ...start(), answers: [[1]], current: 1, lastAtMs: 1_000 };
    const state = putQuiz(putQuiz(EMPTY_BUTTONS_STATE, answered), { ...start(), id: "quiz2" });
    expect(idleQuizzes(state, 1_000 + QUIZ_IDLE_MS - 1)).toEqual([]);
    expect(idleQuizzes(state, 1_000 + QUIZ_IDLE_MS).map((quiz) => quiz.id)).toEqual(["quiz1"]);
    expect(quizSummaryText(answered, { stopped: true })).toBe(
      'Quiz «Capitals»: 1/1 right, answered 1 of 2 and stopped.\nQ1 ✓ "Paris"',
    );
  });

  it("the quizzes survive a restart and expire", () => {
    const state = putQuiz(EMPTY_BUTTONS_STATE, start());
    const decoded = decodeButtonsState(JSON.parse(JSON.stringify(state)));
    expect(decoded.quizzes?.map((quiz) => quiz.id)).toEqual(["quiz1"]);
    expect(pruneButtonsState(decoded, Number.MAX_SAFE_INTEGER).quizzes).toEqual([]);
    expect(decodeButtonsState({ groups: [], routes: [] }).quizzes).toBeUndefined();
  });
});
