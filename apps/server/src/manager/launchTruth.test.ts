import { describe, expect, it } from "vitest";

import {
  annotateDispatcherHistory,
  claimsLaunch,
  decideLaunchTruth,
  launchCheckPromptText,
  launchesOfTurn,
  NOT_LAUNCHED_FACT,
  notLaunchedText,
  type LaunchActivity,
} from "./launchTruth.ts";

/** A chat_create activity as Hermes records it on the canary (30.10, shapes trimmed). */
const chatCreate = (turnId: string, options: { failed?: boolean; errorResult?: boolean } = {}) =>
  ({
    kind: "tool.completed",
    summary: "mcp__uno_work__chat_create",
    turnId,
    payload: {
      itemType: "dynamic_tool_call",
      status: options.failed ? "failed" : "completed",
      detail: options.errorResult
        ? JSON.stringify({
            result: JSON.stringify({
              error: "harness_not_ready",
              message: "Claude is not signed in",
            }),
          })
        : JSON.stringify({
            result: JSON.stringify({
              ok: true,
              threadId: "876c0451-6dd7-423c-a99e-b6b5a47045d2",
              projectId: "7810bcec-d582-42c9-9cc0-9a10b6f13eb5",
              title: "Читать package.json в shop-demo",
            }),
          }).slice(0, 180) + "...",
      data: {
        toolCallId: "tc-1",
        kind: "other",
        rawInput: {
          cwd: "~/projects/shop-demo",
          text: "Прочитай файл package.json в проекте shop-demo",
          title: "Читать package.json в shop-demo",
        },
      },
    },
  }) satisfies LaunchActivity;

const workStatus = (turnId: string): LaunchActivity => ({
  kind: "tool.completed",
  summary: "mcp__uno_manager__work_status",
  turnId,
  payload: { itemType: "dynamic_tool_call", status: "completed", detail: "{}" },
});

describe("claimsLaunch", () => {
  it.each([
    "Принял, запустил «Читать README в shop-demo» — напишу, когда будет готово.",
    "Перезапустил чтение package.json — напишу, когда будет готово.",
    "Отдал в работу, вернусь с результатом.",
    "Создал отдельный чат «Бэклог» и передал ему задачу.",
    "Запущено: «Читать src/app.ts».",
    "Got it — launched «Read README».",
    "I started a chat for this, will report back.",
    "Kicked it off in a separate chat.",
  ])("a launch claim: %s", (text) => {
    expect(claimsLaunch(text)).toBe(true);
  });

  it.each([
    "Прошлые два по ошибке не запустил — запускаю сейчас?",
    "Не запустил — повтори или уточни.",
    "Сейчас активных задач нет — ничего не выполняется.",
    "Запущу, как только скажешь, в какой папке.",
    "I didn't launch it: Claude isn't connected.",
    "Чем помочь?",
    "",
  ])("not a claim: %s", (text) => {
    expect(claimsLaunch(text)).toBe(false);
  });

  it("a status answer may say «запущен» about earlier work", () => {
    const status = "«Читать package.json» запущен в 01:11 и ещё работает.";
    expect(claimsLaunch(status, { statusTurn: true })).toBe(false);
    expect(claimsLaunch(status)).toBe(true);
    // ...but a first-person claim is one even in a status turn.
    expect(claimsLaunch("Проверил статус и запустил ещё один чат.", { statusTurn: true })).toBe(
      true,
    );
  });
});

describe("launchesOfTurn", () => {
  it("reads the chat a completed chat_create started", () => {
    expect(launchesOfTurn([chatCreate("t1")], "t1")).toEqual([
      {
        tool: "chat_create",
        threadId: "876c0451-6dd7-423c-a99e-b6b5a47045d2",
        title: "Читать package.json в shop-demo",
        cwd: "~/projects/shop-demo",
        model: null,
      },
    ]);
  });

  it("another turn's call, a failed call or an error result start nothing", () => {
    expect(launchesOfTurn([chatCreate("t1")], "t2")).toEqual([]);
    expect(launchesOfTurn([chatCreate("t1", { failed: true })], "t1")).toEqual([]);
    expect(launchesOfTurn([chatCreate("t1", { errorResult: true })], "t1")).toEqual([]);
    expect(launchesOfTurn([workStatus("t1")], "t1")).toEqual([]);
    expect(launchesOfTurn([chatCreate("t1")], null)).toEqual([]);
  });

  it("send_turn to an existing chat counts, with the chat it names", () => {
    const sendTurn: LaunchActivity = {
      kind: "tool.completed",
      summary: "mcp__uno_manager__send_turn",
      turnId: "t1",
      payload: {
        status: "completed",
        detail: '{"result": "{\\"ok\\":true}"}',
        data: { rawInput: { threadId: "5214866f-249f-4b69-ab1a-1c9c9add8bae", text: "ещё" } },
      },
    };
    expect(launchesOfTurn([sendTurn], "t1")[0]?.threadId).toBe(
      "5214866f-249f-4b69-ab1a-1c9c9add8bae",
    );
  });
});

describe("decideLaunchTruth", () => {
  const claim = "Принял, запустил «Читать README в shop-demo» — напишу, когда будет готово.";

  it("a claim backed by a call is fine", () => {
    expect(
      decideLaunchTruth({
        text: claim,
        activities: [chatCreate("t1")],
        turnId: "t1",
        checksMade: 0,
      }),
    ).toEqual({ kind: "ok" });
  });

  it("a claim with no call: one hidden check, then the honest line", () => {
    expect(decideLaunchTruth({ text: claim, activities: [], turnId: "t1", checksMade: 0 })).toEqual(
      {
        kind: "check",
      },
    );
    expect(decideLaunchTruth({ text: claim, activities: [], turnId: "t2", checksMade: 1 })).toEqual(
      {
        kind: "correct",
      },
    );
  });

  it("no claim, nothing to check", () => {
    expect(
      decideLaunchTruth({
        text: "Сейчас активных задач нет.",
        activities: [workStatus("t1")],
        turnId: "t1",
        checksMade: 0,
      }),
    ).toEqual({ kind: "ok" });
  });

  it("texts: the check is a quiet Uno Work note; the honest line is short", () => {
    const prompt = launchCheckPromptText("прочитай файл README в проекте shop-demo");
    expect(prompt.startsWith("(Uno Work) ")).toBe(true);
    expect(prompt).toContain("прочитай файл README в проекте shop-demo");
    expect(notLaunchedText("ru")).toBe("Не запустил — повтори или уточни.");
  });
});

describe("annotateDispatcherHistory", () => {
  const messages = [
    { role: "user" as const, text: "прочитай файл README в проекте shop-demo", turnId: null },
    {
      role: "assistant" as const,
      text: "Принял, запустил «Читать README в shop-demo» — напишу, когда будет готово.",
      turnId: "t1",
    },
    { role: "user" as const, text: "прочитай файл package.json в проекте shop-demo", turnId: null },
    {
      role: "assistant" as const,
      text: "Принял, запустил «Читать package.json в shop-demo» — напишу, когда будет готово.",
      turnId: "t2",
    },
    { role: "user" as const, text: "какие задачи в работе?", turnId: null },
    { role: "assistant" as const, text: "Сейчас активных задач нет.", turnId: "t3" },
  ];

  it("a launch carries its facts; a claim without a call is not carried", () => {
    const out = annotateDispatcherHistory(
      messages,
      [chatCreate("t2"), workStatus("t3")],
      (fact) => ({
        ...fact,
        model: "claudeAgent/claude-sonnet-5",
      }),
    );
    expect(out[1]?.text).toBe(NOT_LAUNCHED_FACT);
    expect(out[3]?.text).toBe(
      "[запущен чат «Читать package.json в shop-demo» (id 876c0451…, папка ~/projects/shop-demo, модель claudeAgent/claude-sonnet-5)]\n" +
        "Принял, запустил «Читать package.json в shop-demo» — напишу, когда будет готово.",
    );
    expect(out[5]?.text).toBe("Сейчас активных задач нет.");
    expect(out[0]).toBe(messages[0]);
    // No bare "запустил" without its fact is left to copy.
    for (const message of out) {
      if (message.role === "assistant" && message.text.includes("запустил")) {
        expect(message.text.startsWith("[запущен чат")).toBe(true);
      }
    }
  });
});
