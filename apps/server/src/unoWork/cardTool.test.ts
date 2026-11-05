import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { CARD_EXAMPLES, SHOW_CARD_DESCRIPTION } from "./cardTool.ts";
import { runUnoWorkTool, UNO_WORK_TOOLS, type UnoWorkToolDeps } from "./tools.ts";

const tool = UNO_WORK_TOOLS.find((entry) => entry.name === "show_card")!;

interface Recorded {
  pages: Array<{ html: string; title: string; height: number }>;
  messages: Array<Record<string, unknown>>;
}

const makeDeps = (
  options: {
    readonly fromMessenger?: boolean;
    readonly delivered?: number;
    readonly cwd?: string;
  } = {},
) => {
  const recorded: Recorded = { pages: [], messages: [] };
  const home = options.cwd ?? os.tmpdir();
  const deps = {
    caller: {
      threadId: "thread-1",
      threadTitle: "Chat",
      runtimeMode: "full-access",
      cwd: options.cwd,
      boundary: null,
    },
    home,
    htmlRender: {
      publish: (page: { html: string; title: string; height: number }) =>
        Effect.sync(() => {
          recorded.pages.push(page);
          return { attachmentId: "a1", title: page.title, height: page.height } as never;
        }),
      capture: () => Effect.die("unused"),
    },
    messengerSend: (input: Record<string, unknown>) =>
      Effect.sync(() => {
        recorded.messages.push(input);
        return options.delivered === 0
          ? { delivered: 0, via: "none" as const, note: "No Telegram." }
          : { delivered: 1, via: "telegram" as const, note: null, drawn: "rich" as const };
      }),
    ...(options.fromMessenger !== undefined
      ? { answeringMessenger: Effect.succeed(options.fromMessenger) }
      : {}),
  } as unknown as UnoWorkToolDeps;
  return { deps, recorded };
};

const run = (deps: UnoWorkToolDeps, args: unknown) =>
  Effect.runPromiseExit(runUnoWorkTool(tool, deps, args));

const errorOf = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "";

describe("show_card", () => {
  it("is described with hard triggers and one working example per kind", () => {
    expect(tool.group).toBe("person");
    expect(tool.level).toBe("safe");
    expect(SHOW_CARD_DESCRIPTION).toContain("never ask a multiple-choice question as plain text");
    expect(SHOW_CARD_DESCRIPTION).toContain("END YOUR TURN");
    for (const example of Object.values(CARD_EXAMPLES)) {
      expect(SHOW_CARD_DESCRIPTION).toContain(example);
    }
  });

  it("every example in the description is a valid call", async () => {
    for (const example of Object.values(CARD_EXAMPLES)) {
      const { deps, recorded } = makeDeps();
      const exit = await run(deps, JSON.parse(example));
      expect(Exit.isSuccess(exit), errorOf(exit)).toBe(true);
      expect(recorded.pages).toHaveLength(1);
    }
  });

  it("in the chat: a page like html_render, then end the turn", async () => {
    const { deps, recorded } = makeDeps({ fromMessenger: false });
    const exit = await run(deps, {
      kind: "choice",
      question: "Deploy now?",
      // A weak model's shortcut: options as plain strings.
      options: ["Deploy", "Wait"],
    });
    expect(Exit.isSuccess(exit), errorOf(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value).toMatchObject({ ok: true, shown: "chat" });
    expect((exit.value as { next: string }).next).toMatch(/^End your turn now/);
    expect(recorded.messages).toEqual([]);
    expect(recorded.pages[0]!.title).toBe("Deploy now?");
    expect(recorded.pages[0]!.html).toContain("Deploy now?");
    // The html_render bridge is in, so a press answers the chat.
    expect(recorded.pages[0]!.html).toContain("uno.send");
  });

  it("a turn from Telegram: the card goes there, drawn natively", async () => {
    const { deps, recorded } = makeDeps({ fromMessenger: true });
    const exit = await run(deps, JSON.parse(CARD_EXAMPLES.quiz));
    expect(Exit.isSuccess(exit), errorOf(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value).toMatchObject({ ok: true, shown: "telegram", drawn: "rich" });
    expect(recorded.pages).toEqual([]);
    expect(recorded.messages[0]!.card).toMatchObject({ kind: "quiz", title: "Capitals" });
    expect(String(recorded.messages[0]!.text)).toContain("Capital of France?");
  });

  it("Telegram doesn't take it: the chat shows it and the model is told to write it out", async () => {
    const { deps, recorded } = makeDeps({ fromMessenger: true, delivered: 0 });
    const exit = await run(deps, JSON.parse(CARD_EXAMPLES.choice));
    expect(Exit.isSuccess(exit), errorOf(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(recorded.pages).toHaveLength(1);
    expect((exit.value as { note: string }).note).toContain("write the question and options");
  });

  it("where: messenger without a messenger fails with the reason", async () => {
    const { deps } = makeDeps({ delivered: 0 });
    const exit = await run(deps, { ...JSON.parse(CARD_EXAMPLES.choice), where: "messenger" });
    expect(errorOf(exit)).toContain("not sent to the messenger: No Telegram.");
  });

  it("a wrong call says what to fix and shows a call that works", async () => {
    const { deps } = makeDeps();
    const noKind = await run(deps, { question: "Which?" });
    expect(errorOf(noKind)).toContain('kind must be \\"choice\\"');
    const badQuiz = await run(deps, {
      kind: "quiz",
      questions: [{ question: "2+2?", options: ["3", "4"], correct: [2] }],
    });
    const text = errorOf(badQuiz);
    expect(text).toContain("questions[0].correct must be option numbers from 0 to 1");
    expect(text).toContain("A quiz that works:");
    expect(text).toContain("Capital of France?");
  });

  it("a report's files: relative to the chat's folder, missing ones refused by name", async () => {
    const folder = mkdtempSync(path.join(os.tmpdir(), "uno-card-"));
    writeFileSync(path.join(folder, "notes.txt"), "hello");
    const { deps, recorded } = makeDeps({ fromMessenger: true, cwd: folder });
    const missing = await run(deps, {
      kind: "report",
      title: "Done",
      files: ["notes.txt", "gone.pdf"],
    });
    expect(errorOf(missing)).toContain("these files don't exist: gone.pdf");
    const exit = await run(deps, { kind: "report", title: "Done", files: ["notes.txt"] });
    expect(Exit.isSuccess(exit), errorOf(exit)).toBe(true);
    expect(recorded.messages[0]!.cardFiles).toEqual([path.join(folder, "notes.txt")]);
    // No actions: nothing to wait for.
    if (Exit.isSuccess(exit)) {
      expect((exit.value as { next: string }).next).not.toMatch(/End your turn/);
    }
  });
});
