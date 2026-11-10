/**
 * `show_card`: the agent answers the person with a card — a choice, a quiz
 * or a report with "what next" buttons (`@t3tools/shared/personCard`). The
 * agent fills plain fields; Uno draws it where the person is: a page in this
 * chat (`personCardHtml.ts`, published like `html_render`), or their
 * Telegram when this turn answers a message from there: in a private chat a
 * live widget (`manager/telegramWidgetCard.ts`), else or refused a Rich
 * Message / quiz polls (`manager/telegramRichCard.ts`); `drawn` in the
 * result says which. Whatever the person picks comes
 * back to the chat as their next, visible message (Misha, 05.11).
 *
 * Built for weak models: one tool, few fields, a forgiving validator whose
 * every error says how to fix the call, with a working example.
 */
import { promises as fsp } from "node:fs";

import {
  PERSON_CARD_TOOL_NAME,
  personCardToMarkdown,
  validatePersonCard,
  type PersonCard,
} from "@t3tools/shared/personCard";
import { renderPersonCardHtml } from "@t3tools/shared/personCardHtml";
import { Effect } from "effect";

import { HtmlRenderProblem, preparePage } from "../htmlRender/htmlRender.ts";
import { boundaryDenial } from "./pathBoundary.ts";
import type { ObjectSchema } from "./argsSchema.ts";
import type { UnoWorkTool, UnoWorkToolDeps, UnoWorkToolError } from "./tools.ts";

type Deps = UnoWorkToolDeps;

/** What the tool needs from tools.ts (passed in: no runtime import cycle). */
export interface CardToolKit {
  readonly resolvePath: (raw: string, deps: Deps) => string;
  readonly fail: (message: string) => UnoWorkToolError;
}

/** One working call per kind: the error of a bad call ends with the right one. */
export const CARD_EXAMPLES = {
  choice:
    '{"kind":"choice","question":"Which plan?","options":[{"label":"Small","description":"$5, one bot"},{"label":"Plus","recommended":true}]}',
  quiz: '{"kind":"quiz","title":"Capitals","questions":[{"question":"Capital of France?","options":["Lyon","Paris"],"correct":[1],"explanation":"Paris since 508."}]}',
  report:
    '{"kind":"report","title":"Site checked","summary":"2 problems, both easy","metrics":[{"label":"Speed","value":"92/100","tone":"good"}],"sections":[{"heading":"Problems","markdown":"- No favicon\\n- Slow hero image"}],"actions":[{"label":"Fix both","style":"success"},{"label":"Leave it"}]}',
} as const;

const END_TURN = "End your turn now. The person's answer comes to this chat as their next message.";

const OPTION = {
  type: "object",
  properties: {
    label: { type: "string", description: "Button text, 1–60 characters." },
    description: { type: "string", description: "Optional, one short line under the label." },
    recommended: { type: "boolean", description: "true on the option you advise (one)." },
    prompt: {
      type: "string",
      description: "Optional: what you get back when it is picked; default the label.",
    },
  },
  required: ["label"],
  additionalProperties: false,
} as const;

const QUESTION = {
  type: "object",
  properties: {
    question: { type: "string" },
    options: {
      type: "array",
      items: { type: "string" },
      description: '2–8 answers: ["Lyon","Paris"].',
    },
    correct: {
      type: "array",
      items: { type: "integer" },
      description: "Numbers of the right answers, 0 = first: [1] means the second.",
    },
    explanation: { type: "string", description: "Optional: why, shown after answering." },
  },
  required: ["question", "options", "correct"],
  additionalProperties: false,
} as const;

const SECTION = {
  type: "object",
  properties: {
    heading: { type: "string" },
    markdown: { type: "string", description: "Plain Markdown: lines, lists, bold, links." },
    table: {
      type: "object",
      properties: {
        columns: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: { type: "string" } } },
      },
      required: ["columns", "rows"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

export const SHOW_CARD_INPUT_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["choice", "quiz", "report"],
      description:
        "choice: the person decides. quiz: questions with right answers. report: a result with buttons for what next.",
    },
    where: {
      type: "string",
      enum: ["auto", "chat", "messenger"],
      description:
        "Default auto: their Telegram/Slack when this turn answers a message from there, else this chat.",
    },
    title: { type: "string", description: "Short. Required for a report." },
    question: { type: "string", description: "choice: the question, one line." },
    options: { type: "array", items: OPTION, description: "choice: 2–8 options." },
    multiple: { type: "boolean", description: "choice: they may pick several." },
    allowOther: { type: "boolean", description: "choice: they may type their own answer." },
    questions: { type: "array", items: QUESTION, description: "quiz: 1–10 questions." },
    summary: { type: "string", description: "report: the outcome in one or two lines." },
    metrics: {
      type: "array",
      description: 'report: up to 6 numbers: [{"label":"Visitors","value":"1 240","tone":"good"}].',
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          value: { type: "string" },
          note: { type: "string" },
          tone: { type: "string", enum: ["good", "bad", "neutral"] },
        },
        required: ["label", "value"],
        additionalProperties: false,
      },
    },
    sections: {
      type: "array",
      items: SECTION,
      description: "report: parts, each Markdown or a table.",
    },
    images: {
      type: "array",
      items: { type: "string" },
      description:
        "report: picture files on this computer (~/…, absolute, or relative to this chat's folder).",
    },
    files: {
      type: "array",
      items: { type: "string" },
      description: "report: files to hand over (same paths).",
    },
    actions: {
      type: "array",
      description:
        'report: 2–4 buttons for what to do next: [{"label":"Publish it","style":"success"},{"label":"Change the text"}].',
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "1–40 characters." },
          prompt: {
            type: "string",
            description: "Optional: what you get back; default the label.",
          },
          style: { type: "string", enum: ["primary", "success", "danger"] },
        },
        required: ["label"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind"],
  additionalProperties: false,
} as const satisfies ObjectSchema;

export const SHOW_CARD_DESCRIPTION = [
  "Answer the person with an interactive card instead of plain text; Uno draws it in this chat or in their Telegram. Use it whenever it fits:",
  "- the person must decide between options → kind choice (never ask a multiple-choice question as plain text);",
  "- a check of knowledge, a lesson, a game move with a right answer → kind quiz;",
  "- you finished a task with a result worth seeing (numbers, a comparison, findings, files) → kind report with 2–4 actions for what to do next.",
  "Their pick comes back to this chat as their next message: after show_card END YOUR TURN. Plain conversational answers stay text.",
  `Examples: ${CARD_EXAMPLES.choice} · ${CARD_EXAMPLES.quiz} · ${CARD_EXAMPLES.report}`,
].join("\n");

const kindOf = (args: Record<string, unknown>): keyof typeof CARD_EXAMPLES | null => {
  const kind = args.kind ?? args.type;
  return kind === "choice" || kind === "quiz" || kind === "report" ? kind : null;
};

/** The error a bad call gets: what is wrong, then a call that works. */
export const cardErrorText = (error: string, args: Record<string, unknown>): string => {
  const kind = kindOf(args);
  const example =
    kind === null
      ? `For example: ${CARD_EXAMPLES.choice}`
      : `A ${kind} that works: ${CARD_EXAMPLES[kind]}`;
  return `show_card: ${error} Fix it and call show_card again. ${example}`;
};

/** The chat page's title: the card's own words. */
const pageTitle = (card: PersonCard): string =>
  card.kind === "report"
    ? card.title
    : card.kind === "choice"
      ? (card.title ?? card.question)
      : (card.title ?? card.questions[0]?.question ?? "Quiz");

/** The frame's first height before the page measures itself (it then fits). */
const estimateHeight = (card: PersonCard): number => {
  switch (card.kind) {
    case "choice":
      return 140 + card.options.length * 56;
    case "quiz":
      return 180 + Math.max(...card.questions.map((question) => question.options.length)) * 52;
    case "report":
      return 420;
  }
};

/** Reads the args into a card; the paths of a report resolved and checked. */
const readCard = (deps: Deps, args: Record<string, unknown>, kit: CardToolKit) =>
  Effect.gen(function* () {
    const { where: _where, ...fields } = args;
    const checked = validatePersonCard(fields);
    if (!checked.ok) return yield* kit.fail(cardErrorText(checked.error, args));
    const card = checked.card;
    if (card.kind !== "report") return card;
    const resolve = (list: ReadonlyArray<string> | undefined) =>
      Effect.forEach(list ?? [], (raw) =>
        Effect.try({
          try: () => ({ raw, path: kit.resolvePath(raw, deps) }),
          catch: (cause) =>
            (cause as { readonly _tag?: unknown } | null)?._tag === "UnoWorkToolError"
              ? (cause as UnoWorkToolError)
              : kit.fail(`show_card: ${raw} is not a usable path.`),
        }),
      );
    const images = yield* resolve(card.images);
    const files = yield* resolve(card.files);
    const missing: string[] = [];
    for (const entry of [...images, ...files]) {
      const isFile = yield* Effect.promise(() =>
        fsp.stat(entry.path).then(
          (info) => info.isFile(),
          () => false,
        ),
      );
      if (!isFile) missing.push(entry.raw);
    }
    if (missing.length > 0) {
      return yield* kit.fail(
        `show_card: these files don't exist: ${missing.join(", ")}. Use paths of existing files (~/…, absolute, or relative to this chat's folder), or leave them out.`,
      );
    }
    return {
      ...card,
      ...(images.length > 0 ? { images: images.map((entry) => entry.path) } : {}),
      ...(files.length > 0 ? { files: files.map((entry) => entry.path) } : {}),
    } satisfies PersonCard;
  });

/** The card as a page in this chat, published like `html_render`. */
const showInChat = (deps: Deps, card: PersonCard, kit: CardToolKit) =>
  Effect.gen(function* () {
    if (!deps.htmlRender) return null;
    const prepared = yield* Effect.tryPromise({
      try: () =>
        preparePage(renderPersonCardHtml(card), {
          resolve: (reference) => kit.resolvePath(reference, deps),
          denied: (absolute) => boundaryDenial(absolute, deps.caller.boundary, deps.home),
        }),
      catch: (cause) =>
        kit.fail(
          cause instanceof HtmlRenderProblem ||
            (cause as { readonly _tag?: unknown } | null)?._tag === "UnoWorkToolError"
            ? `show_card: ${(cause as Error).message}`
            : "show_card: the card could not be drawn.",
        ),
    });
    if (prepared.missing.length > 0) {
      return yield* kit.fail(
        `show_card: these pictures could not be read: ${prepared.missing.join(", ")}. Use image files (png, jpg, webp, gif) or leave them out.`,
      );
    }
    yield* deps.htmlRender.publish({
      html: prepared.html,
      title: pageTitle(card),
      height: estimateHeight(card),
      // Our renderer, no agent script: a press answers at once. The only
      // place a page gets it (html_render's pages fill the message box).
      source: "card",
    });
    return true;
  });

/**
 * What the model is told after the card is up. `answering`: this turn
 * answers their Telegram / Slack message — its final text would go there
 * too ("Done." when empty), so it ends with NO_REPLY (connectorReplies).
 */
const shownResult = (
  card: PersonCard,
  shown: "chat" | "telegram" | "slack" | "uno-bot",
  answering = false,
) => {
  const waits = card.kind !== "report" || (card.actions?.length ?? 0) > 0;
  const where =
    shown === "chat"
      ? "Shown in the chat above your reply. Don't repeat the card in text."
      : shown === "telegram"
        ? "Sent to the person's Telegram. Don't repeat it in your reply."
        : "Sent to the person as text (no buttons there).";
  return {
    ok: true,
    shown,
    message: where,
    next:
      answering && shown !== "chat"
        ? "End your turn now with exactly NO_REPLY: the card is already there. The person's answer comes to this chat as their next message."
        : waits
          ? END_TURN
          : "Reply with one short line at most, or nothing.",
  };
};

export const personCardTools = (kit: CardToolKit): ReadonlyArray<UnoWorkTool> => [
  {
    name: PERSON_CARD_TOOL_NAME,
    group: "person",
    description: SHOW_CARD_DESCRIPTION,
    inputSchema: SHOW_CARD_INPUT_SCHEMA as unknown as ObjectSchema,
    // validatePersonCard reads the fields itself, forgiving where intent is
    // clear (an option as a plain string, `correct: 1`) and with errors that
    // show a working call; the strict schema check would refuse those.
    lenientArgs: true,
    level: "safe",
    run: (deps, args) =>
      Effect.gen(function* () {
        const card = yield* readCard(deps, args, kit);
        const where = args.where === "chat" || args.where === "messenger" ? args.where : "auto";
        const answering =
          where !== "chat" &&
          deps.answeringMessenger !== undefined &&
          (yield* deps.answeringMessenger);
        const messenger = where === "messenger" || answering;
        let messengerNote: string | null = null;
        if (messenger && deps.messengerSend !== undefined) {
          const sent = yield* deps.messengerSend({
            text: personCardToMarkdown(card),
            card,
            ...(card.kind === "report" && card.images ? { cardImages: card.images } : {}),
            ...(card.kind === "report" && card.files ? { cardFiles: card.files } : {}),
          });
          if (sent.delivered > 0 && sent.via !== "none") {
            return {
              ...shownResult(card, sent.via, answering),
              ...(sent.drawn !== undefined ? { drawn: sent.drawn } : {}),
              ...(sent.note ? { note: sent.note } : {}),
            };
          }
          messengerNote = sent.note ?? "Not delivered.";
          if (where === "messenger") {
            return yield* kit.fail(
              `show_card: not sent to the messenger: ${messengerNote} Try where: "chat".`,
            );
          }
        }
        const inChat = yield* showInChat(deps, card, kit);
        if (inChat === null) {
          return {
            ok: false,
            message: "Cards can't be shown here. Put this in your reply as text instead:",
            text: personCardToMarkdown(card),
          };
        }
        return {
          ...shownResult(card, "chat"),
          ...(messengerNote !== null
            ? {
                note: `Telegram didn't take it (${messengerNote}); it is in the chat instead. Your reply still goes to Telegram: write the question and options in it as text.`,
              }
            : {}),
        };
      }),
  },
];
