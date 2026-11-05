/**
 * `show_card` cards through the real Telegram connector against a fake Bot
 * API (global `fetch` stub, Uno's assistant bot relay):
 *
 * - a multiple choice goes as a Rich Message with toggles; presses mark the
 *   picked ones, Done answers the chat once with all of them;
 * - a quiz goes as non-anonymous quiz polls, one after each answer, and ONE
 *   message with the score answers the chat at the end; a stranger's answer
 *   doesn't count;
 * - the relay (or an old Bot API) refuses sendRichMessage → the old message
 *   with the same buttons, and a press still answers the chat;
 * - the poller asks for `poll_answer` updates.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import {
  ASSISTANT_PROJECT_ID,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepositoryLive } from "../persistence/Layers/ManagerConnectorBindings.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ProjectionPendingApprovalRepository } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CONTROL_PLANE_URL_OVERRIDE_ENV } from "../workspaceRegistry/unoCloudParse.ts";
import { validatePersonCard, type PersonCard } from "@t3tools/shared/personCard";
import { ManagerTelegramService, ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";

const CONSOLE = "http://console.test";
const TGA = "tga_" + "d".repeat(64);
const CHAT = 4242;
const STRANGER = 5151;
const projectId = ASSISTANT_PROJECT_ID;
const WORK = ThreadId.make("work-thread-1");
const WORK_PROJECT = ProjectId.make("project-site");

interface Recorded {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

let queued: Array<unknown> = [];
let calls: Array<Recorded> = [];
let nextMessageId = 500;
let pending: Array<{ readonly requestId: string; readonly status: string }> = [];
let richRefused = false;
let nextPoll = 0;

const json = (body: unknown) => Response.json(body);

const installFetch = () => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let body: Record<string, unknown> = {};
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = {};
        }
      }
      calls.push({ url, body });
      const path = new URL(url).pathname;
      if (path.endsWith("/getMe")) return json({ ok: true, result: { username: "uno_work_bot" } });
      if (path.endsWith("/getUpdates")) {
        if (queued.length > 0) return json({ ok: true, result: [queued.shift()] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return json({ ok: true, result: [] });
      }
      if (path.endsWith("/sendMessage")) {
        nextMessageId += 1;
        return json({ ok: true, result: { message_id: nextMessageId } });
      }
      if (path.endsWith("/sendRichMessage")) {
        if (richRefused) {
          return json({
            ok: false,
            error_code: 403,
            description: "Forbidden: method sendRichMessage is not available through the Uno relay",
          });
        }
        nextMessageId += 1;
        return json({ ok: true, result: { message_id: nextMessageId } });
      }
      if (path.endsWith("/sendPoll")) {
        nextMessageId += 1;
        nextPoll += 1;
        return json({
          ok: true,
          result: { message_id: nextMessageId, poll: { id: `poll-${nextPoll}` } },
        });
      }
      if (
        /\/(sendChatAction|answerCallbackQuery|editMessageText|editMessageReplyMarkup)$/.test(path)
      ) {
        return json({ ok: true, result: true });
      }
      return new Response("not found", { status: 404 });
    }),
  );
};

const dispatched: Array<OrchestrationCommand> = [];

beforeEach(() => {
  vi.stubEnv(CONTROL_PLANE_URL_OVERRIDE_ENV, CONSOLE);
  queued = [];
  pending = [];
  richRefused = false;
  dispatched.length = 0;
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const workShell = {
  id: WORK,
  projectId: WORK_PROJECT,
  title: "Fix the site",
  archivedAt: null,
  modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};

const repositories = Layer.mergeAll(
  ManagerConnectorRepositoryLive,
  ManagerConnectorBindingRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const connectorLayer = ManagerTelegramServiceLive.pipe(
  Layer.provideMerge(repositories),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: [],
            updatedAt: "2026-10-29T00:00:00.000Z",
          }),
        getThreadShellById: (id) =>
          Effect.succeed(id === WORK ? Option.some(workShell as never) : Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
        getProjectShellById: (id) =>
          Effect.succeed(
            Option.some({
              id,
              title: "Uno",
              workspaceRoot: "/tmp/Uno",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-10-29T00:00:00.000Z",
              updatedAt: "2026-10-29T00:00:00.000Z",
            }),
          ),
      }),
      Layer.mock(ProjectionPendingApprovalRepository)({
        listByThreadId: () =>
          Effect.succeed(
            pending.map((row) => ({
              requestId: row.requestId,
              status: row.status,
              threadId: WORK,
              createdAt: "2026-10-29T00:00:00.000Z",
            })) as never,
          ),
      }),
      ServerSettingsService.layerTest({ uno: { apiKey: "sk-uno-test" } } as never),
      ServerConfig.layerTest(process.cwd(), { prefix: "uno-tg-cards-test-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const saveRow = Effect.gen(function* () {
  const repository = yield* ManagerConnectorRepository;
  yield* repository.upsert({
    projectId,
    kind: "telegram",
    config: {
      botToken: `unorelay:${TGA}`,
      allowedChatIds: [String(CHAT)],
      ownerUserIds: [String(CHAT)],
      enabled: true,
      defaultModelSelection: null,
    },
    updatedAt: new Date().toISOString(),
  });
});

let nextUpdate = 1;
const press = (data: string, messageId: number, fromId = CHAT) => ({
  update_id: nextUpdate++,
  callback_query: {
    id: `cb-${nextUpdate}`,
    from: { id: fromId, is_bot: false, language_code: "en" },
    message: {
      message_id: messageId,
      chat: { id: CHAT, type: "private" },
      from: { id: 1, is_bot: true },
      text: "whatever",
    },
    data,
  },
});

const waitUntil = (check: () => boolean, attempts = 80) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (check()) return true;
      yield* Effect.sleep("100 millis");
    }
    return check();
  });

const callsTo = (method: string) =>
  calls.filter((call) => new URL(call.url).pathname.endsWith(`/${method}`));

const turnTexts = () =>
  dispatched.flatMap((command) =>
    command.type === "thread.turn.start"
      ? [{ threadId: command.threadId, text: command.message.text }]
      : [],
  );

const cardOf = (input: unknown): PersonCard => {
  const checked = validatePersonCard(input);
  if (!checked.ok) throw new Error(checked.error);
  return checked.card;
};

const keyboardOf = (call: Recorded | undefined) =>
  call?.body.reply_markup as
    | {
        inline_keyboard: ReadonlyArray<
          ReadonlyArray<{ text: string; callback_data?: string; style?: string }>
        >;
      }
    | undefined;

const pollAnswer = (pollId: string, optionIds: ReadonlyArray<number>, fromId = CHAT) => ({
  update_id: nextUpdate++,
  poll_answer: {
    poll_id: pollId,
    user: { id: fromId, is_bot: false },
    option_ids: optionIds,
  },
});

it.live("a multiple choice: a Rich Message with toggles, Done answers the chat once", () =>
  Effect.gen(function* () {
    yield* saveRow;
    const telegram = yield* ManagerTelegramService;
    const sent = yield* telegram.sendCard({
      projectId,
      chatId: String(CHAT),
      threadId: WORK,
      header: "💬 Fix the site",
      card: cardOf({
        kind: "choice",
        question: "Which pages?",
        options: ["Home", "Pricing", { label: "Blog", recommended: true }],
        multiple: true,
      }),
      routeReplies: true,
      language: "en",
    });
    expect(sent).toEqual({ ok: true, error: null, drawn: "rich" });
    const rich = callsTo("sendRichMessage")[0]!;
    expect(rich.body.chat_id).toBe(String(CHAT));
    const richMessage = rich.body.rich_message as { markdown: string };
    expect(richMessage.markdown).toContain("💬 Fix the site");
    expect(richMessage.markdown).toContain("**Which pages?**");
    expect(callsTo("sendMessage")).toEqual([]);
    const keyboard = keyboardOf(rich)!;
    expect(keyboard.inline_keyboard.map((row) => row[0]!.text)).toEqual([
      "Home",
      "Pricing",
      "Blog",
      "Done",
    ]);
    expect(keyboard.inline_keyboard[2]![0]!.style).toBe("success");
    const data = keyboard.inline_keyboard.map((row) => row[0]!.callback_data!);
    const messageId = nextMessageId;

    // The poller asks Telegram for quiz answers too.
    expect(
      yield* waitUntil(() =>
        callsTo("getUpdates").some((call) => decodeURIComponent(call.url).includes("poll_answer")),
      ),
    ).toBe(true);

    // Done with nothing picked: a toast, nothing sent.
    queued.push(press(data[3]!, messageId));
    expect(yield* waitUntil(() => callsTo("answerCallbackQuery").length === 1)).toBe(true);
    expect(callsTo("answerCallbackQuery")[0]?.body.text).toBe("Pick an option first.");

    queued.push(press(data[0]!, messageId));
    queued.push(press(data[2]!, messageId));
    expect(yield* waitUntil(() => callsTo("editMessageReplyMarkup").length === 2)).toBe(true);
    const marked = keyboardOf(callsTo("editMessageReplyMarkup")[1])!;
    expect(marked.inline_keyboard.map((row) => row[0]!.text)).toEqual([
      "✅ Home",
      "Pricing",
      "✅ Blog",
      "Done",
    ]);
    expect(turnTexts()).toEqual([]);

    queued.push(press(data[3]!, messageId));
    expect(yield* waitUntil(() => turnTexts().length > 0)).toBe(true);
    expect(turnTexts()[0]).toEqual({ threadId: WORK, text: "Picked: Home; Blog" });
    // The Rich Message keeps its content: its keyboard becomes the line.
    expect(yield* waitUntil(() => callsTo("editMessageReplyMarkup").length === 3)).toBe(true);
    expect(keyboardOf(callsTo("editMessageReplyMarkup")[2])).toEqual({
      inline_keyboard: [[{ text: "✔ Home, Blog", disabled: {} }]],
    });
    expect(callsTo("editMessageText")).toEqual([]);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("a quiz: quiz polls one by one, ONE summary at the end, a stranger doesn't count", () =>
  Effect.gen(function* () {
    yield* saveRow;
    const telegram = yield* ManagerTelegramService;
    const sent = yield* telegram.sendCard({
      projectId,
      chatId: String(CHAT),
      threadId: WORK,
      header: null,
      card: cardOf({
        kind: "quiz",
        title: "Capitals",
        questions: [
          { question: "Capital of France?", options: ["Lyon", "Paris"], correct: [1] },
          { question: "Capital of Italy?", options: ["Rome", "Milan"], correct: [0] },
        ],
      }),
      language: "en",
    });
    expect(sent).toEqual({ ok: true, error: null, drawn: "poll" });
    expect(String(callsTo("sendMessage")[0]?.body.text)).toContain("Capitals · 2 questions");
    expect(callsTo("sendPoll")).toHaveLength(1);
    expect(callsTo("sendPoll")[0]?.body).toMatchObject({
      chat_id: String(CHAT),
      question: "1/2 · Capital of France?",
      is_anonymous: false,
      type: "quiz",
      correct_option_ids: [1],
    });

    queued.push(pollAnswer("poll-1", [0], STRANGER));
    queued.push(pollAnswer("poll-1", [0]));
    expect(yield* waitUntil(() => callsTo("sendPoll").length === 2)).toBe(true);
    expect(callsTo("sendPoll")[1]?.body.question).toBe("2/2 · Capital of Italy?");
    expect(turnTexts()).toEqual([]);

    queued.push(pollAnswer("poll-2", [0]));
    expect(yield* waitUntil(() => turnTexts().length > 0)).toBe(true);
    expect(turnTexts()[0]).toEqual({
      threadId: WORK,
      text: 'Quiz «Capitals»: 1/2 right.\nQ1 ✗ picked "Lyon", right "Paris"\nQ2 ✓ "Rome"',
    });
    // A late extra answer: the quiz is over, nothing more.
    queued.push(pollAnswer("poll-2", [1]));
    yield* Effect.sleep("400 millis");
    expect(turnTexts()).toHaveLength(1);
    expect(callsTo("sendPoll")).toHaveLength(2);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("the relay refuses a Rich Message: the old message with the same buttons", () =>
  Effect.gen(function* () {
    yield* saveRow;
    richRefused = true;
    const telegram = yield* ManagerTelegramService;
    const sent = yield* telegram.sendCard({
      projectId,
      chatId: String(CHAT),
      threadId: WORK,
      header: "💬 Fix the site",
      card: cardOf({
        kind: "report",
        title: "Site checked",
        summary: "2 problems",
        metrics: [{ label: "Speed", value: "92" }],
        actions: [{ label: "Fix both", prompt: "Fix both problems" }, "Leave it"],
      }),
      routeReplies: true,
      language: "en",
    });
    expect(sent).toEqual({ ok: true, error: null, drawn: "text" });
    expect(callsTo("sendRichMessage")).toHaveLength(1);
    const fallback = callsTo("sendMessage")[0]!;
    expect(String(fallback.body.text)).toContain("Site checked");
    expect(String(fallback.body.text)).toContain("Speed");
    const keyboard = keyboardOf(fallback)!;
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toEqual([
      "Fix both",
      "Leave it",
    ]);
    queued.push(press(keyboard.inline_keyboard[0]![0]!.callback_data!, nextMessageId));
    expect(yield* waitUntil(() => turnTexts().length > 0)).toBe(true);
    expect(turnTexts()[0]).toEqual({ threadId: WORK, text: "Fix both problems" });
    // A plain message is rewritten as before: its text and "✔ <label>".
    expect(yield* waitUntil(() => callsTo("editMessageText").length > 0)).toBe(true);
    expect(String(callsTo("editMessageText")[0]?.body.text)).toContain("✔ Fix both");
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("messenger_send rich: the agent's own Rich Message, the plain text when refused", () =>
  Effect.gen(function* () {
    yield* saveRow;
    const telegram = yield* ManagerTelegramService;
    const first = yield* telegram.sendRich({
      projectId,
      chatId: String(CHAT),
      text: "Report: | a | b |",
      rich: { markdown: "# Report\n| a | b |\n|---|---|\n| 1 | 2 |" },
      threadId: WORK,
    });
    expect(first.ok).toBe(true);
    expect(callsTo("sendRichMessage")[0]?.body.rich_message).toEqual({
      markdown: "# Report\n| a | b |\n|---|---|\n| 1 | 2 |",
    });
    expect(callsTo("sendMessage")).toEqual([]);
    richRefused = true;
    const second = yield* telegram.sendRich({
      projectId,
      chatId: String(CHAT),
      text: "Report: plain",
      rich: { html: "<h2>Report</h2>" },
      threadId: WORK,
    });
    expect(second.ok).toBe(true);
    expect(callsTo("sendRichMessage")[1]?.body.rich_message).toEqual({ html: "<h2>Report</h2>" });
    expect(String(callsTo("sendMessage")[0]?.body.text)).toContain("Report: plain");
  }).pipe(Effect.provide(connectorLayer)),
);
