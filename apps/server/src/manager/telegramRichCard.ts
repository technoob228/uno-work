/**
 * `show_card` in Telegram — the pure half: what a card (a choice, a quiz, a
 * report; `@t3tools/shared/personCard`) becomes on the Bot API.
 *
 * - **Choice / report** → a Rich Message (`sendRichMessage`, Bot API 10.1+):
 *   Rich Markdown with headings, a table of metrics, sections, pictures and
 *   documents embedded (`tg://photo?id=…` / `tg://document?id=…` + the
 *   message's `media`, uploaded in the same multipart request), and our
 *   inline keyboard (`ub1:` buttons, connectorButtons.ts) under it. A choice
 *   with `multiple` gets toggles and "Done".
 * - **Quiz** → native quiz polls, non-anonymous (the bot gets `poll_answer`),
 *   one question at a time; the score goes to the chat once at the end.
 * - **Fallback** (the relay or Telegram refuses a Rich Message, an old Bot
 *   API) → the old `sendMessage` (HTML) with the same keyboard, the card as
 *   plain Markdown (`personCardToMarkdown`); a quiz → its questions as text.
 *
 * @module manager/telegramRichCard
 */
import {
  personCardPrompt,
  personCardToMarkdown,
  type PersonCard,
  type PersonCardChoice,
  type PersonCardQuiz,
  type PersonCardReport,
} from "@t3tools/shared/personCard";
import { ruPlural } from "@t3tools/shared/personCardWidget";

import {
  layoutButtons,
  type ButtonStyle,
  type CardQuiz,
  type ConnectorButton,
  type ConnectorButtonsState,
} from "./connectorButtons.ts";
import type { ReplyLanguage } from "./connectorReplyText.ts";

// ── Limits (Bot API) ─────────────────────────────────────────────────────

/** Rich message text: "Up to 32768 UTF-8 characters"; we stay below it. */
export const RICH_MESSAGE_MAX_CHARS = 30_000;
/** "Up to 50 media attachments in total." */
export const RICH_MESSAGE_MAX_MEDIA = 50;
/** One multipart request through the relay: 50 MB (`MaxMultipartBody`), with room for the text. */
export const RICH_MESSAGE_MAX_UPLOAD_BYTES = 45 * 1024 * 1024;
/** sendPoll: question 1-300, options 1-100 characters, 1-12 options, explanation 0-200. */
export const POLL_QUESTION_MAX_CHARS = 300;
export const POLL_OPTION_MAX_CHARS = 100;
export const POLL_EXPLANATION_MAX_CHARS = 200;
/** A button label Telegram shows in full on a phone (connectorButtons). */
const BUTTON_LABEL_MAX_CHARS = 40;
/** A quiz left half answered this long sends what was answered. */
export const QUIZ_IDLE_MS = 30 * 60_000;
/** A quiz nobody started is dropped after this. */
export const QUIZ_TTL_MS = 3 * 24 * 60 * 60_000;

// ── Text ─────────────────────────────────────────────────────────────────

const say = (language: ReplyLanguage, ru: string, en: string) => (language === "ru" ? ru : en);

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

/**
 * Plain text inside Rich Markdown: Markdown and HTML punctuation escaped
 * (CommonMark backslash escapes), `$` too — two of them on a line would be
 * a formula.
 */
export const escapeRichText = (text: string): string =>
  text.replace(/[\\`*_[\]<>|~=$#!]/g, "\\$&").replace(/\n+/g, " ");

/**
 * The agent's own Markdown (a report section): kept as Markdown, but a
 * bare `$` outside code is escaped — "$40 to $50" must not turn into a
 * formula — and a `<` is shown as typed, not parsed as a Rich HTML tag.
 */
export const safeRichMarkdown = (markdown: string): string => {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      out.push(line);
      continue;
    }
    if (fenced) {
      out.push(line);
      continue;
    }
    out.push(
      line
        .split(/(`[^`]*`)/g)
        .map((part) =>
          part.startsWith("`") && part.endsWith("`") && part.length > 1
            ? part
            : part.replace(/(?<!\\)([$<])/g, "\\$1"),
        )
        .join(""),
    );
  }
  return out.join("\n");
};

const tableCell = (text: string): string => escapeRichText(text).replace(/\s+/g, " ").trim() || " ";

const markdownTable = (
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string =>
  [
    `| ${columns.map(tableCell).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(tableCell).join(" | ")} |`),
  ].join("\n");

const toneMark = (tone: string | undefined): string =>
  tone === "good" ? "🟢 " : tone === "bad" ? "🔴 " : "";

// ── Media ────────────────────────────────────────────────────────────────

/** A local file embedded in a Rich Message, uploaded as the multipart part `id`. */
export interface RichCardMedia {
  /** `[A-Za-z0-9_-]{1,64}`; also the multipart field name. */
  readonly id: string;
  readonly kind: "photo" | "document";
  /** Absolute, already checked against the chat's sendable roots. */
  readonly path: string;
  readonly name: string;
}

/** `InputRichMessage.media`: each entry `attach://<id>` of the same request. */
export const richMediaField = (media: ReadonlyArray<RichCardMedia>) =>
  media.map((entry) => ({
    id: entry.id,
    media: { type: entry.kind, media: `attach://${entry.id}` },
  }));

// ── The message ──────────────────────────────────────────────────────────

export interface RichCardOptions {
  /** "💬 <chat>" for a work chat speaking; null: the assistant itself. */
  readonly header: string | null;
  readonly language: ReplyLanguage;
  /** Report pictures and files that may be embedded (in the card's order). */
  readonly media?: ReadonlyArray<RichCardMedia>;
  /** Report files that could not be embedded: named under the text. */
  readonly notEmbedded?: ReadonlyArray<string>;
}

const headerLines = (header: string | null): string[] =>
  header === null ? [] : [escapeRichText(header), ""];

const choiceMarkdown = (card: PersonCardChoice, options: RichCardOptions): string => {
  const lines = [...headerLines(options.header)];
  if (card.title) lines.push(`## ${escapeRichText(card.title)}`, "");
  lines.push(`**${escapeRichText(card.question)}**`, "");
  // The buttons carry the labels; the list says what a button can't: a
  // description, the recommended one, a label too long for a button.
  const listed = card.options.some(
    (option) =>
      option.description !== undefined ||
      option.recommended === true ||
      option.label.length > BUTTON_LABEL_MAX_CHARS,
  );
  if (listed) {
    card.options.forEach((option, index) => {
      const mark = option.recommended
        ? ` ⭐ _${say(options.language, "советую", "recommended")}_`
        : "";
      const description = option.description ? ` — ${escapeRichText(option.description)}` : "";
      lines.push(`${index + 1}. **${escapeRichText(option.label)}**${mark}${description}`);
    });
    lines.push("");
  }
  if (card.multiple) {
    lines.push(
      `_${say(options.language, "Выберите один или несколько, потом «Готово».", "Pick one or more, then press Done.")}_`,
    );
  }
  if (card.allowOther) {
    lines.push(
      `_${say(options.language, "Или напишите свой ответ.", "Or type your own answer.")}_`,
    );
  }
  return lines.join("\n").trim();
};

const reportMarkdown = (card: PersonCardReport, options: RichCardOptions): string => {
  const lines = [...headerLines(options.header), `# ${escapeRichText(card.title)}`];
  if (card.summary) lines.push("", escapeRichText(card.summary));
  if (card.metrics && card.metrics.length > 0) {
    const withNotes = card.metrics.some((metric) => metric.note !== undefined);
    lines.push(
      "",
      markdownTable(
        [
          say(options.language, "Показатель", "Metric"),
          say(options.language, "Значение", "Value"),
          ...(withNotes ? [say(options.language, "Комментарий", "Note")] : []),
        ],
        card.metrics.map((metric) => [
          metric.label,
          `${toneMark(metric.tone)}${metric.value}`,
          ...(withNotes ? [metric.note ?? ""] : []),
        ]),
      ),
    );
  }
  for (const section of card.sections ?? []) {
    lines.push("");
    if (section.heading) lines.push(`## ${escapeRichText(section.heading)}`, "");
    if (section.markdown) lines.push(safeRichMarkdown(section.markdown));
    if (section.table) {
      if (section.markdown) lines.push("");
      lines.push(markdownTable(section.table.columns, section.table.rows));
    }
  }
  for (const media of options.media ?? []) {
    const link =
      media.kind === "photo" ? `tg://photo?id=${media.id}` : `tg://document?id=${media.id}`;
    const caption = media.kind === "document" ? ` "${media.name.replaceAll('"', "'")}"` : "";
    lines.push("", `![](${link}${caption})`);
  }
  if (options.notEmbedded && options.notEmbedded.length > 0) {
    lines.push(
      "",
      `_${say(options.language, "Файлы придут следом", "Files follow")}: ${options.notEmbedded.map(escapeRichText).join(", ")}_`,
    );
  }
  return lines.join("\n").trim();
};

/** Rich Markdown of a choice or a report (a quiz goes as polls). */
export const cardRichMarkdown = (
  card: PersonCardChoice | PersonCardReport,
  options: RichCardOptions,
): string =>
  clip(
    card.kind === "choice" ? choiceMarkdown(card, options) : reportMarkdown(card, options),
    RICH_MESSAGE_MAX_CHARS,
  );

/** The card where Rich Messages don't work: plain Markdown under the header. */
export const cardPlainText = (
  card: PersonCard,
  header: string | null,
  language: ReplyLanguage,
): string => {
  const body = personCardToMarkdown(card);
  const hint =
    card.kind === "choice" && card.multiple
      ? say(
          language,
          "Выберите один или несколько, потом «Готово».",
          "Pick one or more, then press Done.",
        )
      : card.kind === "quiz"
        ? say(
            language,
            "Ответьте одним сообщением, например: 1A 2C",
            "Answer in one message, e.g.: 1A 2C",
          )
        : null;
  return [header, body, hint]
    .filter((part): part is string => part !== null && part !== "")
    .join("\n\n");
};

// ── Buttons ──────────────────────────────────────────────────────────────

const buttonLabel = (label: string, index: number, numbered: boolean): string =>
  clip(numbered ? `${index + 1}. ${label}` : label, BUTTON_LABEL_MAX_CHARS);

/**
 * The keyboard of a choice or a report. A press of a choice option / an
 * action answers the chat with `personCardPrompt`; with `multiple` the
 * options toggle and "Done" sends the picked ones.
 */
export const cardButtons = (
  card: PersonCardChoice | PersonCardReport,
  language: ReplyLanguage,
): ReadonlyArray<ReadonlyArray<ConnectorButton>> => {
  if (card.kind === "report") {
    const actions = (card.actions ?? []).map((action): ConnectorButton => {
      const label = clip(action.label, BUTTON_LABEL_MAX_CHARS);
      const reply = { kind: "reply", value: personCardPrompt(action) } as const;
      return action.style === undefined
        ? { label, action: reply }
        : { label, action: reply, style: action.style };
    });
    return actions.length === 0 ? [] : layoutButtons(actions);
  }
  const numbered = card.options.some((option) => option.label.length > BUTTON_LABEL_MAX_CHARS);
  const options = card.options.map((option, index): ConnectorButton => {
    const style: ButtonStyle | undefined = option.recommended ? "success" : undefined;
    return {
      label: buttonLabel(option.label, index, numbered),
      action: card.multiple
        ? { kind: "toggle", value: personCardPrompt(option) }
        : { kind: "reply", value: personCardPrompt(option) },
      ...(style !== undefined ? { style } : {}),
    };
  });
  if (!card.multiple) return layoutButtons(options);
  return [
    ...options.map((option) => [option]),
    [
      {
        label: say(language, "Готово", "Done"),
        action: { kind: "submit" },
        style: "primary",
      },
    ],
  ];
};

/** What "Done" sends to the chat: the picked options, as the person's message. */
export const pickedMessage = (values: ReadonlyArray<string>, language: ReplyLanguage): string =>
  values.length === 1 ? values[0]! : `${say(language, "Выбрал", "Picked")}: ${values.join("; ")}`;

/** "Done" with nothing picked. */
export const nothingPickedToast = (language: ReplyLanguage): string =>
  say(language, "Сначала выберите вариант.", "Pick an option first.");

// ── Quiz ─────────────────────────────────────────────────────────────────

/** The line before the first poll (a title, how many questions). */
export const quizIntroText = (
  card: PersonCardQuiz,
  header: string | null,
  language: ReplyLanguage,
): string => {
  const count = card.questions.length;
  const what = say(
    language,
    `${count} ${ruPlural(count, "вопрос", "вопроса", "вопросов")}`,
    count === 1 ? "1 question" : `${count} questions`,
  );
  const title = card.title
    ? `🧩 ${card.title} · ${what}`
    : `🧩 ${say(language, "Квиз", "Quiz")} · ${what}`;
  return [header, title].filter((part): part is string => part !== null).join("\n");
};

/** A new quiz in progress (its first poll not sent yet). */
export const newCardQuiz = (input: {
  readonly id: string;
  readonly card: PersonCardQuiz;
  readonly connectorProjectId: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly language: ReplyLanguage;
  readonly nowMs: number;
}): CardQuiz => ({
  id: input.id,
  connectorProjectId: input.connectorProjectId,
  chatId: input.chatId,
  threadId: input.threadId,
  title: input.card.title ?? null,
  questions: input.card.questions.map((question) => ({
    question: question.question,
    options: question.options,
    correct: question.correct,
    ...(question.explanation !== undefined ? { explanation: question.explanation } : {}),
  })),
  current: 0,
  pollId: null,
  answers: [],
  language: input.language,
  createdAtMs: input.nowMs,
  lastAtMs: input.nowMs,
  expiresAtMs: input.nowMs + QUIZ_TTL_MS,
});

/** `sendPoll` parameters (without chat_id) of the quiz's current question. */
export const quizPollParams = (quiz: CardQuiz): Record<string, unknown> => {
  const question = quiz.questions[quiz.current]!;
  const total = quiz.questions.length;
  const prefix = total > 1 ? `${quiz.current + 1}/${total} · ` : "";
  const explanation = question.explanation
    ? clip(question.explanation.replace(/\n{2,}/g, "\n"), POLL_EXPLANATION_MAX_CHARS)
    : undefined;
  return {
    question: clip(`${prefix}${question.question}`, POLL_QUESTION_MAX_CHARS),
    options: question.options.map((option) => ({ text: clip(option, POLL_OPTION_MAX_CHARS) })),
    is_anonymous: false,
    type: "quiz",
    correct_option_ids: [...question.correct],
    ...(question.correct.length > 1 ? { allows_multiple_answers: true } : {}),
    ...(explanation !== undefined ? { explanation } : {}),
  };
};

const sameSet = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));

const optionTexts = (options: ReadonlyArray<string>, picks: ReadonlyArray<number>): string =>
  picks.map((index) => `"${options[index] ?? "?"}"`).join(", ");

/**
 * The ONE message a quiz sends to the chat when it ends: the score, then
 * each question right or wrong (what was picked and what was right).
 */
export const quizSummaryText = (
  quiz: CardQuiz,
  options: { readonly stopped?: boolean } = {},
): string => {
  const language = quiz.language ?? "en";
  const answered = quiz.answers.length;
  const right = quiz.answers.filter((picks, index) =>
    sameSet(picks, quiz.questions[index]?.correct ?? []),
  ).length;
  const name = quiz.title ? ` «${quiz.title}»` : "";
  const head =
    options.stopped === true && answered < quiz.questions.length
      ? say(
          language,
          `Квиз${name}: ${right}/${answered} верно, ответил на ${answered} из ${quiz.questions.length} и остановился.`,
          `Quiz${name}: ${right}/${answered} right, answered ${answered} of ${quiz.questions.length} and stopped.`,
        )
      : say(
          language,
          `Квиз${name}: ${right}/${answered} верно.`,
          `Quiz${name}: ${right}/${answered} right.`,
        );
  const lines = quiz.answers.map((picks, index) => {
    const question = quiz.questions[index]!;
    return sameSet(picks, question.correct)
      ? `Q${index + 1} ✓ ${optionTexts(question.options, picks)}`
      : say(
          language,
          `Q${index + 1} ✗ выбрал ${optionTexts(question.options, picks)}, верно ${optionTexts(question.options, question.correct)}`,
          `Q${index + 1} ✗ picked ${optionTexts(question.options, picks)}, right ${optionTexts(question.options, question.correct)}`,
        );
  });
  return [head, ...lines].join("\n");
};

/** The quiz whose current poll this is, or null. */
export const findQuizByPoll = (state: ConnectorButtonsState, pollId: string): CardQuiz | null =>
  (state.quizzes ?? []).find((quiz) => quiz.pollId === pollId) ?? null;

export const putQuiz = (state: ConnectorButtonsState, quiz: CardQuiz): ConnectorButtonsState => ({
  ...state,
  quizzes: [...(state.quizzes ?? []).filter((entry) => entry.id !== quiz.id), quiz],
});

export const removeQuiz = (
  state: ConnectorButtonsState,
  quizId: string,
): ConnectorButtonsState => ({
  ...state,
  quizzes: (state.quizzes ?? []).filter((entry) => entry.id !== quizId),
});

/** The stored quiz is still the one `expected` saw: same question, answers and poll. */
const sameQuizStep = (stored: CardQuiz, expected: CardQuiz): boolean =>
  stored.id === expected.id &&
  stored.current === expected.current &&
  stored.answers.length === expected.answers.length &&
  stored.pollId === expected.pollId;

/**
 * Moves a quiz from the step `expected` saw to `next`, only if it is still
 * there at that step: a quiz finished (its score sent) or moved on by someone
 * else meanwhile — the idle flush, a second answer — is not brought back
 * (no second score 30 minutes later). Run it inside one state update.
 */
export const advanceQuiz = (
  state: ConnectorButtonsState,
  expected: CardQuiz,
  next: CardQuiz,
): { readonly state: ConnectorButtonsState; readonly applied: boolean } => {
  const quizzes = state.quizzes ?? [];
  const stored = quizzes.find((entry) => entry.id === expected.id);
  if (stored === undefined || !sameQuizStep(stored, expected)) return { state, applied: false };
  return {
    state: { ...state, quizzes: quizzes.map((entry) => (entry === stored ? next : entry)) },
    applied: true,
  };
};

/**
 * Takes a quiz out to finish it, only if it is still at the step `expected`
 * saw; `applied: false` — someone else finished or moved it: send no score.
 */
export const takeQuiz = (
  state: ConnectorButtonsState,
  expected: CardQuiz,
): { readonly state: ConnectorButtonsState; readonly applied: boolean } => {
  const quizzes = state.quizzes ?? [];
  const stored = quizzes.find((entry) => entry.id === expected.id);
  if (stored === undefined || !sameQuizStep(stored, expected)) return { state, applied: false };
  return {
    state: { ...state, quizzes: quizzes.filter((entry) => entry !== stored) },
    applied: true,
  };
};

/**
 * A `poll_answer` for the quiz's current poll: the picks are recorded and
 * the quiz moves on — `next` (send the next poll) or `done` (send the score).
 * An empty answer (a retracted vote) changes nothing.
 */
export const answerQuiz = (
  quiz: CardQuiz,
  optionIds: ReadonlyArray<number>,
  nowMs: number,
): { readonly kind: "ignore" } | { readonly kind: "next" | "done"; readonly quiz: CardQuiz } => {
  if (optionIds.length === 0 || quiz.answers.length !== quiz.current) return { kind: "ignore" };
  const picks = [...new Set(optionIds)].toSorted((left, right) => left - right);
  const answered: CardQuiz = {
    ...quiz,
    answers: [...quiz.answers, picks],
    lastAtMs: nowMs,
  };
  if (answered.answers.length >= quiz.questions.length) return { kind: "done", quiz: answered };
  return { kind: "next", quiz: { ...answered, current: quiz.current + 1, pollId: null } };
};

/** Quizzes the person left half answered for {@link QUIZ_IDLE_MS}: their score goes now. */
export const idleQuizzes = (state: ConnectorButtonsState, nowMs: number): ReadonlyArray<CardQuiz> =>
  (state.quizzes ?? []).filter(
    (quiz) => quiz.answers.length > 0 && nowMs - quiz.lastAtMs >= QUIZ_IDLE_MS,
  );
