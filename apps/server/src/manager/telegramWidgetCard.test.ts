import { describe, expect, it } from "vitest";

import type { AgentWidget, ButtonGroup, ConnectorButtonsState } from "./connectorButtons.ts";
import { EMPTY_BUTTONS_STATE } from "./connectorButtons.ts";
import { newCardQuiz } from "./telegramRichCard.ts";
import {
  admitAgentWidgetRequest,
  AGENT_WIDGET_REQUESTS_PER_MINUTE,
  agentWidgetMessage,
  agentWidgetTitle,
  answerWidgetQuiz,
  decideWidgetPick,
  lastAgentWidget,
  parseWidgetRequest,
  putAgentWidget,
  spendWidgetGroup,
  validateAgentWidget,
  widgetRequestPrefix,
  widgetSizeProblem,
  widgetStateProblem,
} from "./telegramWidgetCard.ts";

const group = (overrides: Partial<ButtonGroup> = {}): ButtonGroup => ({
  id: "AbCdEfGhIjKl",
  connectorProjectId: "p",
  chatId: "42",
  messageId: 7,
  threadId: "t",
  rows: [
    [
      { label: "Small", action: { kind: "reply", value: "Small" } },
      { label: "Plus", action: { kind: "reply", value: "Move me to Plus" } },
    ],
  ],
  widget: true,
  createdAtMs: 0,
  expiresAtMs: 10_000,
  ...overrides,
});

const toggles = group({
  rows: [
    [{ label: "Home", action: { kind: "toggle", value: "Home" } }],
    [{ label: "Blog", action: { kind: "toggle", value: "Blog posts" } }],
    [{ label: "Done", action: { kind: "submit" } }],
  ],
});

describe("widget requests", () => {
  it("parses w1:<id>:[q.]<hexmask>, ≤ 64 bytes; anything else is not a card's", () => {
    const prefix = widgetRequestPrefix("AbCdEfGhIjKl");
    expect(parseWidgetRequest(`${prefix}2`)).toEqual({
      id: "AbCdEfGhIjKl",
      question: null,
      picks: [1],
    });
    expect(parseWidgetRequest(`${prefix}9.ff`)).toEqual({
      id: "AbCdEfGhIjKl",
      question: 9,
      picks: [0, 1, 2, 3, 4, 5, 6, 7],
    });
    expect(Buffer.byteLength(`${prefix}9.ff`)).toBeLessThanOrEqual(64);
    for (const bad of [
      `${prefix}0`,
      `${prefix}x`,
      "e4",
      "w1:short:1",
      `${prefix}1.2.3`,
      undefined,
    ]) {
      expect(parseWidgetRequest(bad)).toBeNull();
    }
  });
});

describe("a choice / report widget", () => {
  it("one option → its value; a forged mask → bad; spent → the final state, once", () => {
    expect(decideWidgetPick(group(), [1], "en")).toEqual({
      kind: "ok",
      picks: [1],
      text: "Move me to Plus",
      state: '{"p":[1],"d":1}',
    });
    expect(decideWidgetPick(group(), [0, 1], "en").kind).toBe("bad");
    expect(decideWidgetPick(group(), [5], "en").kind).toBe("bad");
    const state: ConnectorButtonsState = { ...EMPTY_BUTTONS_STATE, groups: [group()] };
    const first = spendWidgetGroup(state, "AbCdEfGhIjKl", [1]);
    expect(first.applied).toBe(true);
    expect(spendWidgetGroup(first.state, "AbCdEfGhIjKl", [0]).applied).toBe(false);
    expect(decideWidgetPick(first.state.groups[0]!, [0], "en")).toEqual({
      kind: "spent",
      state: '{"p":[1],"d":1}',
    });
  });

  it("toggles: the picked values as one message", () => {
    expect(decideWidgetPick(toggles, [0, 1], "ru")).toMatchObject({
      kind: "ok",
      text: "Выбрал: Home; Blog posts",
      state: '{"p":[0,1],"d":1}',
    });
    expect(decideWidgetPick(toggles, [2], "en").kind).toBe("bad");
  });
});

describe("a quiz widget", () => {
  const quiz = newCardQuiz({
    id: "AbCdEfGhIjKl",
    card: {
      kind: "quiz",
      questions: [
        { question: "1?", options: ["a", "b"], correct: [1] },
        { question: "2?", options: ["a", "b"], correct: [0] },
      ],
    },
    connectorProjectId: "p",
    chatId: "42",
    threadId: "t",
    language: "en",
    nowMs: 0,
  });

  it("the current question moves it on; the last one ends it; others are stale", () => {
    const first = answerWidgetQuiz(quiz, 0, [1], 1);
    expect(first).toMatchObject({ kind: "next", state: '{"a":[[1]]}' });
    if (first.kind !== "next") throw new Error("next");
    expect(answerWidgetQuiz(first.quiz, 0, [0], 2)).toEqual({
      kind: "stale",
      state: '{"a":[[1]]}',
    });
    expect(answerWidgetQuiz(first.quiz, 5, [0], 2).kind).toBe("stale");
    expect(answerWidgetQuiz(first.quiz, 1, [7], 2).kind).toBe("stale");
    expect(answerWidgetQuiz(first.quiz, 1, [0], 2)).toMatchObject({
      kind: "done",
      state: '{"a":[[1],[0]],"d":1}',
    });
  });
});

describe("an agent's own widget", () => {
  it("validation says how to fix the call", () => {
    expect(validateAgentWidget("x")).toMatchObject({ ok: false });
    expect(validateAgentWidget({ html: "" })).toMatchObject({
      error: expect.stringContaining("widget.html is required"),
    });
    expect(validateAgentWidget({ html: "<input>" })).toMatchObject({
      error: expect.stringContaining("buttons only"),
    });
    expect(validateAgentWidget({ html: '<script src="https://x"></script>' })).toMatchObject({
      error: expect.stringContaining("no external scripts"),
    });
    // Random bytes don't compress: over 4 KB deflated.
    const noise = Array.from({ length: 9000 }, (_, index) =>
      ((index * 2_654_435_761) >>> 0).toString(36),
    ).join("");
    const tooBig = validateAgentWidget({ html: `<div>${noise.slice(0, 20_000)}</div>` });
    expect(tooBig).toMatchObject({
      ok: false,
      error: expect.stringContaining("too big when compressed"),
    });
    expect(tooBig.ok ? "" : tooBig.error).toMatch(/shorten the CSS\/JS, no images/);
    expect(widgetSizeProblem("x".repeat(40_000))).toContain("at most 32768");
    expect(validateAgentWidget({ html: "<div/>", state: "x".repeat(1025) })).toMatchObject({
      error: expect.stringContaining("1025 bytes; at most 1024"),
    });
    expect(validateAgentWidget({ html: "<div/>", height: 900 })).toMatchObject({ ok: false });
    expect(
      validateAgentWidget({ html: "<div/>", state: "{}", height: 300, caption: " Game " }),
    ).toEqual({
      ok: true,
      widget: { html: "<div/>", state: "{}", height: 300, caption: "Game" },
    });
    expect(widgetStateProblem({ a: 1 }, "widget_update.state")).toContain("must be text");
  });

  it("its requests: marked, rate-limited; widget_update finds the last one of the chat", () => {
    const widget: AgentWidget = {
      connectorProjectId: "p",
      chatId: "42",
      messageId: 9,
      threadId: "t",
      title: agentWidgetTitle("\nChess\nYour move"),
      sentAtMs: 0,
      expiresAtMs: 100_000,
    };
    expect(agentWidgetMessage(widget, " e4 ")).toBe("[from the widget «Chess»]\ne4");
    let state = putAgentWidget(EMPTY_BUTTONS_STATE, widget);
    state = putAgentWidget(state, { ...widget, messageId: 11, sentAtMs: 5 });
    expect(
      lastAgentWidget(state, { connectorProjectId: "p", chatId: "42", threadId: "t", nowMs: 10 })
        ?.messageId,
    ).toBe(11);
    expect(
      lastAgentWidget(state, {
        connectorProjectId: "p",
        chatId: "42",
        threadId: "t",
        nowMs: 200_000,
      }),
    ).toBeNull();
    for (let index = 0; index < AGENT_WIDGET_REQUESTS_PER_MINUTE; index += 1) {
      const current = state.widgets!.find((entry) => entry.messageId === 9)!;
      const verdict = admitAgentWidgetRequest(state, current, 1_000 + index);
      expect(verdict.admitted).toBe(true);
      state = verdict.state;
    }
    const current = state.widgets!.find((entry) => entry.messageId === 9)!;
    expect(admitAgentWidgetRequest(state, current, 2_000).admitted).toBe(false);
    expect(admitAgentWidgetRequest(state, current, 70_000).admitted).toBe(true);
  });
});
