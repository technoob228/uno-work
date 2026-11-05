/**
 * A card for the person: a choice, a quiz or a report with "what next"
 * buttons. The agent fills in plain fields (the `show_card` tool) and Uno
 * draws it where the person is: a page in the Work chat, a Rich Message in
 * Telegram, plain text elsewhere. Built so a weak model gets it right: few
 * fields, no markup to learn, and every error says how to fix the call.
 *
 * Whatever the person picks comes back to the agent as the person's next
 * message in the same chat, visibly (Misha, 05.11).
 */

export const PERSON_CARD_TOOL_NAME = "show_card";

export const PERSON_CARD_LIMITS = {
  title: 120,
  question: 300,
  optionLabel: 60,
  optionDescription: 200,
  /** What a press sends back to the agent. Telegram keeps it server-side, so it may be long. */
  prompt: 500,
  minOptions: 2,
  maxOptions: 8,
  quizQuestions: 10,
  quizOptions: 8,
  explanation: 300,
  summary: 400,
  metrics: 6,
  metricLabel: 40,
  metricValue: 40,
  sections: 12,
  sectionMarkdown: 4000,
  tableColumns: 8,
  tableRows: 30,
  tableCell: 200,
  images: 6,
  files: 6,
  actions: 8,
  actionLabel: 40,
} as const;

export type PersonCardTone = "good" | "bad" | "neutral";
export type PersonCardButtonStyle = "primary" | "success" | "danger";

export interface PersonCardAction {
  /** The button text, 1–40 characters. */
  readonly label: string;
  /** What the press sends to the agent as the person's message; the label when omitted. */
  readonly prompt?: string;
  readonly style?: PersonCardButtonStyle;
}

export interface PersonCardOption {
  readonly label: string;
  readonly description?: string;
  /** What picking it sends to the agent; the label when omitted. */
  readonly prompt?: string;
  readonly recommended?: boolean;
}

/** The person decides: one option (or several with `multiple`), optionally their own words. */
export interface PersonCardChoice {
  readonly kind: "choice";
  readonly title?: string;
  readonly question: string;
  readonly options: ReadonlyArray<PersonCardOption>;
  readonly multiple?: boolean;
  /** Offer "Other…" so the person can type their own answer. */
  readonly allowOther?: boolean;
}

export interface PersonCardQuizQuestion {
  readonly question: string;
  readonly options: ReadonlyArray<string>;
  /** Indexes into `options` (0-based) of the right answers; at least one. */
  readonly correct: ReadonlyArray<number>;
  readonly explanation?: string;
}

/** A check with right answers (learning, a game turn). The score comes back to the agent at the end. */
export interface PersonCardQuiz {
  readonly kind: "quiz";
  readonly title?: string;
  readonly questions: ReadonlyArray<PersonCardQuizQuestion>;
}

export interface PersonCardMetric {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly tone?: PersonCardTone;
}

export interface PersonCardTable {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

export interface PersonCardSection {
  readonly heading?: string;
  /** Plain Markdown: paragraphs, lists, bold, links, code. */
  readonly markdown?: string;
  readonly table?: PersonCardTable;
}

/** A result: the outcome first, numbers, sections, files and buttons for what to do next. */
export interface PersonCardReport {
  readonly kind: "report";
  readonly title: string;
  readonly summary?: string;
  readonly metrics?: ReadonlyArray<PersonCardMetric>;
  readonly sections?: ReadonlyArray<PersonCardSection>;
  /** Picture files on this computer (png, jpg, webp, gif). */
  readonly images?: ReadonlyArray<string>;
  /** Any files on this computer, sent as documents. */
  readonly files?: ReadonlyArray<string>;
  readonly actions?: ReadonlyArray<PersonCardAction>;
}

export type PersonCard = PersonCardChoice | PersonCardQuiz | PersonCardReport;
export type PersonCardKind = PersonCard["kind"];

export type PersonCardValidation =
  | { readonly ok: true; readonly card: PersonCard }
  | { readonly ok: false; readonly error: string };

const L = PERSON_CARD_LIMITS;

class CardError extends Error {}

function fail(message: string): never {
  throw new CardError(message);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string, max: number, required: true): string;
function text(value: unknown, where: string, max: number, required?: false): string | undefined;
function text(value: unknown, where: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${where} is required: a short text.`);
    return undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") value = String(value);
  if (typeof value !== "string") fail(`${where} must be text.`);
  const trimmed = (value as string).trim();
  if (trimmed === "") {
    if (required) fail(`${where} is required: a short text.`);
    return undefined;
  }
  if (trimmed.length > max) {
    fail(`${where} is ${trimmed.length} characters; keep it under ${max + 1}.`);
  }
  return trimmed;
}

function list(value: unknown, where: string, max: number, min = 0): unknown[] {
  if (value === undefined || value === null) {
    if (min > 0) fail(`${where} is required: a list of at least ${min}.`);
    return [];
  }
  if (!Array.isArray(value)) fail(`${where} must be a list.`);
  if (value.length < min) fail(`${where} needs at least ${min} items; it has ${value.length}.`);
  if (value.length > max) fail(`${where} has ${value.length} items; at most ${max}.`);
  return value;
}

function flag(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlyArray<T>): T | undefined {
  return typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : undefined;
}

/** Drops the fields left undefined, so optional fields are absent, not `undefined`. */
function compact<T extends object>(value: { [K in keyof T]-?: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function readAction(value: unknown, where: string): PersonCardAction {
  if (typeof value === "string") return { label: text(value, `${where}`, L.actionLabel, true) };
  const raw = record(value, where);
  return compact<PersonCardAction>({
    label: text(raw.label, `${where}.label`, L.actionLabel, true),
    prompt: text(raw.prompt, `${where}.prompt`, L.prompt),
    style: oneOf(raw.style, ["primary", "success", "danger"] as const),
  });
}

function readOption(value: unknown, where: string): PersonCardOption {
  if (typeof value === "string") return { label: text(value, where, L.optionLabel, true) };
  const raw = record(value, where);
  return compact<PersonCardOption>({
    label: text(raw.label, `${where}.label`, L.optionLabel, true),
    description: text(raw.description, `${where}.description`, L.optionDescription),
    prompt: text(raw.prompt, `${where}.prompt`, L.prompt),
    recommended: flag(raw.recommended),
  });
}

function readChoice(raw: Record<string, unknown>): PersonCardChoice {
  const options = list(raw.options, "options", L.maxOptions, L.minOptions).map((option, index) =>
    readOption(option, `options[${index}]`),
  );
  const labels = new Set(options.map((option) => option.label.toLowerCase()));
  if (labels.size !== options.length) fail("options must have different labels.");
  return compact<PersonCardChoice>({
    kind: "choice",
    title: text(raw.title, "title", L.title),
    question: text(raw.question, "question", L.question, true),
    options,
    multiple: flag(raw.multiple),
    allowOther: flag(raw.allowOther),
  });
}

function readQuiz(raw: Record<string, unknown>): PersonCardQuiz {
  const questions = list(raw.questions, "questions", L.quizQuestions, 1).map((entry, index) => {
    const where = `questions[${index}]`;
    const question = record(entry, where);
    const options = list(question.options, `${where}.options`, L.quizOptions, L.minOptions).map(
      (option, optionIndex) =>
        text(option, `${where}.options[${optionIndex}]`, L.optionLabel, true),
    );
    const correctRaw = typeof question.correct === "number" ? [question.correct] : question.correct;
    const correct = list(correctRaw, `${where}.correct`, options.length, 1).map((value) => {
      const index = typeof value === "string" ? Number(value) : value;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= options.length
      ) {
        fail(
          `${where}.correct must be option numbers from 0 to ${options.length - 1} (0 is the first option).`,
        );
      }
      return index;
    });
    return compact<PersonCardQuizQuestion>({
      question: text(question.question, `${where}.question`, L.question, true),
      options,
      correct: [...new Set(correct)].sort((left, right) => left - right),
      explanation: text(question.explanation, `${where}.explanation`, L.explanation),
    });
  });
  return compact<PersonCardQuiz>({
    kind: "quiz",
    title: text(raw.title, "title", L.title),
    questions,
  });
}

function readTable(value: unknown, where: string): PersonCardTable | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = record(value, where);
  const columns = list(raw.columns, `${where}.columns`, L.tableColumns, 1).map((column, index) =>
    text(column, `${where}.columns[${index}]`, L.tableCell, true),
  );
  const rows = list(raw.rows, `${where}.rows`, L.tableRows, 1).map((row, rowIndex) => {
    const cells = list(row, `${where}.rows[${rowIndex}]`, columns.length);
    if (cells.length !== columns.length) {
      fail(
        `${where}.rows[${rowIndex}] has ${cells.length} cells; it needs ${columns.length}, one per column.`,
      );
    }
    return cells.map((cell, cellIndex) =>
      cell === null || cell === undefined
        ? ""
        : (text(cell, `${where}.rows[${rowIndex}][${cellIndex}]`, L.tableCell) ?? ""),
    );
  });
  return { columns, rows };
}

function readReport(raw: Record<string, unknown>): PersonCardReport {
  const metrics = list(raw.metrics, "metrics", L.metrics).map((entry, index) => {
    const metric = record(entry, `metrics[${index}]`);
    return compact<PersonCardMetric>({
      label: text(metric.label, `metrics[${index}].label`, L.metricLabel, true),
      value: text(metric.value, `metrics[${index}].value`, L.metricValue, true),
      note: text(metric.note, `metrics[${index}].note`, L.metricLabel),
      tone: oneOf(metric.tone, ["good", "bad", "neutral"] as const),
    });
  });
  const sections = list(raw.sections, "sections", L.sections).map((entry, index) => {
    const where = `sections[${index}]`;
    const section = typeof entry === "string" ? { markdown: entry } : record(entry, where);
    const result = compact<PersonCardSection>({
      heading: text(section.heading, `${where}.heading`, L.title),
      markdown: text(section.markdown, `${where}.markdown`, L.sectionMarkdown),
      table: readTable(section.table, `${where}.table`),
    });
    if (!result.markdown && !result.table) fail(`${where} needs markdown or a table.`);
    return result;
  });
  const paths = (value: unknown, where: string, max: number) =>
    list(value, where, max).map((path, index) => text(path, `${where}[${index}]`, 1000, true));
  const images = paths(raw.images, "images", L.images);
  const files = paths(raw.files, "files", L.files);
  const actions = list(raw.actions, "actions", L.actions).map((action, index) =>
    readAction(action, `actions[${index}]`),
  );
  return compact<PersonCardReport>({
    kind: "report",
    title: text(raw.title, "title", L.title, true),
    summary: text(raw.summary, "summary", L.summary),
    metrics: metrics.length > 0 ? metrics : undefined,
    sections: sections.length > 0 ? sections : undefined,
    images: images.length > 0 ? images : undefined,
    files: files.length > 0 ? files : undefined,
    actions: actions.length > 0 ? actions : undefined,
  });
}

const LEAKED_ARGUMENT =
  /<arg_key>([^<]*)<\/arg_key>\s*<arg_value>([\s\S]*?)(?:<\/arg_value>|(?=<arg_key>)|$)/g;

function leakedValue(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Some fast models (GLM's tool format) leak the next arguments into a string:
 * `"kind": "choice<arg_key>multiple</arg_key><arg_value>true"`. Seen on
 * uno/fast 05.11; the intent is plain, so the pairs become fields again.
 */
function repairLeakedArguments(raw: Record<string, unknown>): Record<string, unknown> {
  const repaired: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string" || !value.includes("<arg_key>")) continue;
    repaired[key] = value.slice(0, value.indexOf("<arg_key>")).trim();
    for (const [, leakedKey, leakedRaw] of value.matchAll(LEAKED_ARGUMENT)) {
      const name = leakedKey?.trim();
      if (name && !(name in repaired)) repaired[name] = leakedValue(leakedRaw ?? "");
    }
  }
  return repaired;
}

/** A card without `kind` (a weak model forgot it): its fields say which it is. */
function guessKind(raw: Record<string, unknown>): PersonCardKind | undefined {
  if (Array.isArray(raw.questions)) return "quiz";
  if (Array.isArray(raw.options) && raw.question !== undefined) return "choice";
  if (raw.title !== undefined && (raw.summary ?? raw.sections ?? raw.metrics ?? raw.actions)) {
    return "report";
  }
  return undefined;
}

/**
 * Reads what an agent passed. Forgiving where intent is clear (a string for an
 * option, a single number for `correct`), strict where a guess would mislead.
 */
export function validatePersonCard(input: unknown): PersonCardValidation {
  try {
    const raw = repairLeakedArguments(record(input, "The card"));
    const kind = raw.kind ?? raw.type ?? guessKind(raw);
    switch (kind) {
      case "choice":
        return { ok: true, card: readChoice(raw) };
      case "quiz":
        return { ok: true, card: readQuiz(raw) };
      case "report":
        return { ok: true, card: readReport(raw) };
      default:
        return {
          ok: false,
          error:
            'kind must be "choice" (the person decides), "quiz" (questions with right answers) or "report" (a result with buttons for what next).',
        };
    }
  } catch (error) {
    if (error instanceof CardError) return { ok: false, error: error.message };
    throw error;
  }
}

/** What a press on an option or action sends back to the agent. */
export function personCardPrompt(item: PersonCardOption | PersonCardAction): string {
  return item.prompt ?? item.label;
}

/** The card as plain Markdown: the fallback where nothing richer can be drawn, and the chat's transcript. */
export function personCardToMarkdown(card: PersonCard): string {
  const lines: string[] = [];
  switch (card.kind) {
    case "choice": {
      if (card.title) lines.push(`**${card.title}**`, "");
      lines.push(card.question, "");
      card.options.forEach((option, index) => {
        const mark = option.recommended ? " (recommended)" : "";
        const description = option.description ? ` — ${option.description}` : "";
        lines.push(`${index + 1}. ${option.label}${mark}${description}`);
      });
      if (card.allowOther) lines.push("", "Or answer in your own words.");
      break;
    }
    case "quiz": {
      if (card.title) lines.push(`**${card.title}**`, "");
      card.questions.forEach((question, index) => {
        lines.push(`${index + 1}. ${question.question}`);
        question.options.forEach((option, optionIndex) => {
          lines.push(`   ${String.fromCharCode(65 + optionIndex)}) ${option}`);
        });
        lines.push("");
      });
      break;
    }
    case "report": {
      lines.push(`**${card.title}**`);
      if (card.summary) lines.push("", card.summary);
      if (card.metrics) {
        lines.push("");
        for (const metric of card.metrics) {
          lines.push(
            `- ${metric.label}: **${metric.value}**${metric.note ? ` (${metric.note})` : ""}`,
          );
        }
      }
      for (const section of card.sections ?? []) {
        lines.push("");
        if (section.heading) lines.push(`**${section.heading}**`);
        if (section.markdown) lines.push(section.markdown);
        if (section.table) {
          lines.push(`| ${section.table.columns.join(" | ")} |`);
          lines.push(`| ${section.table.columns.map(() => "---").join(" | ")} |`);
          for (const row of section.table.rows) lines.push(`| ${row.join(" | ")} |`);
        }
      }
      if (card.actions) {
        lines.push("", `Next: ${card.actions.map((action) => action.label).join(" · ")}`);
      }
      break;
    }
  }
  return lines.join("\n").trim();
}
