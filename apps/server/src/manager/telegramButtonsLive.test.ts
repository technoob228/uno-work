/**
 * Inline buttons and reply routing through the real Telegram connector
 * against a fake Bot API (global `fetch` stub, Uno's assistant bot relay):
 *
 * - `sendRich` puts an inline keyboard of `ub1:` keys under the message and
 *   names the chat; the owner's press answers the chat as their message,
 *   rewrites the message ("✔ <label>", no buttons) and spends the group;
 * - anyone else's press is refused and changes nothing;
 * - Allow on an approval request resolves it (`thread.approval.respond`);
 * - the owner's reply to a chat's message goes back to that chat;
 * - the poller asks for `callback_query` updates.
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
import { approvalButtons, chatHeaderLine, replyButtons } from "./connectorButtons.ts";
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
      ServerConfig.layerTest(process.cwd(), { prefix: "uno-tg-buttons-test-" }),
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

const sentKeyboard = () => {
  const sent = callsTo("sendMessage").find((call) => call.body.reply_markup !== undefined);
  return sent?.body.reply_markup as
    | { inline_keyboard: ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>> }
    | undefined;
};

const turnTexts = () =>
  dispatched.flatMap((command) =>
    command.type === "thread.turn.start"
      ? [{ threadId: command.threadId, text: command.message.text }]
      : [],
  );

it.live("a choice: the owner's press answers the chat and spends the buttons", () =>
  Effect.gen(function* () {
    yield* saveRow;
    const telegram = yield* ManagerTelegramService;
    const sent = yield* telegram.sendRich({
      projectId,
      chatId: String(CHAT),
      text: `${chatHeaderLine("Fix the site")}\nDeploy now?`,
      buttons: replyButtons([
        [
          { label: "Deploy", value: "Yes, deploy it" },
          { label: "Wait", value: "Wait" },
        ],
      ]),
      threadId: WORK,
      routeReplies: true,
    });
    expect(sent.ok).toBe(true);
    const keyboard = sentKeyboard();
    expect(keyboard?.inline_keyboard[0]?.map((button) => button.text)).toEqual(["Deploy", "Wait"]);
    const data = keyboard!.inline_keyboard[0]![0]!.callback_data;
    expect(data).toMatch(/^ub1:/);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    const messageId = nextMessageId;

    // The poller asks Telegram for button presses too.
    expect(
      yield* waitUntil(() =>
        callsTo("getUpdates").some((call) =>
          decodeURIComponent(call.url).includes("callback_query"),
        ),
      ),
    ).toBe(true);

    // Someone else in the chat: refused, nothing happens.
    queued.push(press(data, messageId, STRANGER));
    expect(yield* waitUntil(() => callsTo("answerCallbackQuery").length > 0)).toBe(true);
    expect(callsTo("answerCallbackQuery")[0]?.body.text).toBe("Only the owner can answer this.");
    expect(callsTo("editMessageText")).toEqual([]);

    // The owner.
    queued.push(press(data, messageId));
    expect(yield* waitUntil(() => turnTexts().length > 0)).toBe(true);
    expect(turnTexts()[0]).toEqual({ threadId: WORK, text: "Yes, deploy it" });
    const edit = callsTo("editMessageText")[0];
    expect(String(edit?.body.text)).toContain("✔ Deploy");
    expect(edit?.body.reply_markup).toEqual({ inline_keyboard: [] });

    // A second tap: the group is spent.
    const answered = callsTo("answerCallbackQuery").length;
    queued.push(press(data, messageId));
    expect(yield* waitUntil(() => callsTo("answerCallbackQuery").length > answered)).toBe(true);
    expect(callsTo("answerCallbackQuery").at(-1)?.body.text).toBe(
      "This button has expired. Answer in a message instead.",
    );
    yield* Effect.sleep("300 millis");
    expect(turnTexts()).toHaveLength(1);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("Allow on an approval request resolves it", () =>
  Effect.gen(function* () {
    yield* saveRow;
    pending = [{ requestId: "req-7", status: "pending" }];
    const telegram = yield* ManagerTelegramService;
    yield* telegram.sendRich({
      projectId,
      chatId: String(CHAT),
      text: "💬 Fix the site: wants to run a command:\nnpm install",
      buttons: approvalButtons("req-7", "en"),
      threadId: WORK,
    });
    const data = sentKeyboard()!.inline_keyboard[0]![0]!.callback_data;
    queued.push(press(data, nextMessageId));
    expect(
      yield* waitUntil(() =>
        dispatched.some((command) => command.type === "thread.approval.respond"),
      ),
    ).toBe(true);
    const respond = dispatched.find((command) => command.type === "thread.approval.respond");
    expect(respond).toMatchObject({ threadId: WORK, requestId: "req-7", decision: "accept" });
    expect(yield* waitUntil(() => callsTo("editMessageText").length > 0)).toBe(true);
    expect(String(callsTo("editMessageText")[0]?.body.text)).toContain("✔ ✅ Allow");
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("answered in the app: the Telegram message loses its buttons", () =>
  Effect.gen(function* () {
    yield* saveRow;
    const telegram = yield* ManagerTelegramService;
    yield* telegram.sendRich({
      projectId,
      chatId: String(CHAT),
      text: "💬 Fix the site: wants to change files",
      buttons: approvalButtons("req-9", "en"),
      threadId: WORK,
    });
    yield* telegram.retireRequestButtons("req-9");
    const edit = callsTo("editMessageText")[0];
    expect(String(edit?.body.text)).toContain("✔ Already answered");
    expect(edit?.body.reply_markup).toEqual({ inline_keyboard: [] });
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("the owner's reply to a chat's message goes back to that chat", () =>
  Effect.gen(function* () {
    yield* saveRow;
    const telegram = yield* ManagerTelegramService;
    yield* telegram.sendRich({
      projectId,
      chatId: String(CHAT),
      text: `${chatHeaderLine("Fix the site")}\nWhich domain?`,
      threadId: WORK,
      routeReplies: true,
    });
    queued.push({
      update_id: nextUpdate++,
      message: {
        message_id: 9001,
        chat: { id: CHAT, type: "private" },
        from: { id: CHAT, is_bot: false, language_code: "en" },
        text: "example.org",
        reply_to_message: { message_id: nextMessageId, from: { id: 1, is_bot: true } },
      },
    });
    expect(yield* waitUntil(() => turnTexts().length > 0)).toBe(true);
    expect(turnTexts()[0]?.threadId).toBe(WORK);
    expect(turnTexts()[0]?.text).toContain("example.org");
  }).pipe(Effect.provide(connectorLayer)),
);
