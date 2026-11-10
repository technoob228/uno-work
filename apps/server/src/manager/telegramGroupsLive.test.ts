/**
 * Who the assistant answers in Telegram groups (10.11), through the real
 * Telegram connector against a fake Bot API (global `fetch` stub — nothing
 * leaves the test):
 *
 * - in a group only the owner is heard until the owner picks people or lets
 *   everyone in — per group; whoever wrote is remembered so they can be
 *   picked by name;
 * - a person let in talks in a chat apart from the owner's, approval-only,
 *   marked as holding a stranger's text, with a line saying who writes;
 * - a group the owner called the bot in is offered as waiting and the bot
 *   says where to add it; a stranger's group is never remembered;
 * - Uno's shared bot takes no groups.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import { ASSISTANT_PROJECT_ID, type OrchestrationCommand } from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { OutsideThreads } from "../automations/outsideThreads.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepositoryLive } from "../persistence/Layers/ManagerConnectorBindings.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ProjectionPendingApprovalRepository } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ManagerTelegramService, ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";

const OWN = "123456:own-bot-token-for-tests-only";
const TGA = "tga_" + "c".repeat(64);
const OWNER = 777;
const ANNA = 7;
const DIMA = 8;
const FAMILY = -100500;
const BOOK_CLUB = -100900;
const projectId = ASSISTANT_PROJECT_ID;

let queued: Array<unknown> = [];
let sent: Array<{ readonly chatId: string; readonly text: string }> = [];
const marked: Array<string> = [];
const dispatched: Array<OrchestrationCommand> = [];

const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  queued = [];
  sent = [];
  marked.length = 0;
  dispatched.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      if (path.endsWith("/getMe")) return json({ ok: true, result: { username: "my_bot" } });
      if (path.endsWith("/getUpdates")) {
        if (queued.length > 0) return json({ ok: true, result: [queued.shift()] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return json({ ok: true, result: [] });
      }
      if (path.endsWith("/sendMessage")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          chat_id?: unknown;
          text?: unknown;
        };
        sent.push({ chatId: String(body.chat_id), text: String(body.text ?? "") });
        return json({ ok: true, result: { message_id: 1 } });
      }
      if (path.endsWith("/sendChatAction")) return json({ ok: true, result: true });
      return new Response("not found", { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

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
            updatedAt: "2026-11-10T00:00:00.000Z",
          }),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
        getProjectShellById: (id) =>
          Effect.succeed(
            Option.some({
              id,
              title: "Uno",
              workspaceRoot: "/tmp/Uno",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-11-10T00:00:00.000Z",
              updatedAt: "2026-11-10T00:00:00.000Z",
            }),
          ),
      }),
      Layer.mock(ProjectionPendingApprovalRepository)({
        listByThreadId: () => Effect.succeed([]),
      }),
      Layer.succeed(OutsideThreads, {
        has: (threadId) => Effect.succeed(marked.includes(threadId)),
        mark: (threadId) => Effect.sync(() => void marked.push(threadId)),
      }),
      ServerSettingsService.layerTest({ uno: { apiKey: "sk-uno-test" } } as never),
      ServerConfig.layerTest(process.cwd(), { prefix: "uno-tg-groups-test-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const saveRow = (botToken: string, allowedChatIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    yield* repository.upsert({
      projectId,
      kind: "telegram",
      config: {
        botToken,
        allowedChatIds: [...allowedChatIds],
        ownerUserIds: [String(OWNER)],
        enabled: true,
        defaultModelSelection: null,
      },
      updatedAt: new Date().toISOString(),
    });
  });

let nextId = 1;
const groupUpdate = (
  chat: { readonly id: number; readonly title: string },
  from: { readonly id: number; readonly first_name: string; readonly username?: string },
  text: string,
) => {
  const id = nextId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      chat: { ...chat, type: "supergroup" },
      from: { ...from, is_bot: false, language_code: "en" },
      text,
    },
  };
};
const family = { id: FAMILY, title: "Family" };
const owner = { id: OWNER, first_name: "Misha" };
const anna = { id: ANNA, first_name: "Anna", username: "anna_k" };
const dima = { id: DIMA, first_name: "Dima" };

const waitUntil = (check: () => boolean, attempts = 80) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (check()) return true;
      yield* Effect.sleep("100 millis");
    }
    return check();
  });

const turns = () =>
  dispatched.flatMap((command) => (command.type === "thread.turn.start" ? [command] : []));
/** Waits until the poller has taken everything queued, then a moment more. */
const settle = Effect.gen(function* () {
  yield* waitUntil(() => queued.length === 0);
  yield* Effect.sleep("400 millis");
});

it.live("in a group only the owner is heard, until people are picked — per group", () =>
  Effect.gen(function* () {
    yield* saveRow(OWN, [String(OWNER), String(FAMILY)]);
    const telegram = yield* ManagerTelegramService;

    // Anna calls the bot: ignored, but remembered so the owner can pick her.
    queued.push(groupUpdate(family, anna, "@my_bot what's for dinner?"));
    yield* settle;
    expect(turns()).toEqual([]);
    const before = yield* telegram.groups(projectId);
    expect(before.supported).toBe(true);
    expect(before.groups).toEqual([
      {
        chatId: String(FAMILY),
        title: "Family",
        members: "owners",
        people: [
          {
            id: String(ANNA),
            name: "Anna",
            username: "anna_k",
            owner: false,
            selected: false,
            allowed: false,
          },
        ],
      },
    ]);

    // The owner picks Anna.
    const changed = yield* telegram.setGroupAccess({
      projectId,
      chatId: String(FAMILY),
      members: "selected",
      userIds: [String(ANNA)],
    });
    expect(changed.ok).toBe(true);

    queued.push(groupUpdate(family, anna, "@my_bot what's for dinner?"));
    expect(yield* waitUntil(() => turns().length === 1)).toBe(true);
    const annaTurn = turns()[0]!;
    expect(annaTurn.message.text).toContain(
      '[From Anna (@anna_k), a member of the Telegram group "Family"',
    );
    expect(annaTurn.message.text).toContain("not your owner");
    expect(annaTurn.message.text).toContain("what's for dinner?");
    // Approval-only, and its tools ask: the chat holds a stranger's text.
    expect(annaTurn.runtimeMode).toBe("approval-required");
    expect(marked).toEqual([annaTurn.threadId]);

    // Dima was not picked: still silence.
    queued.push(groupUpdate(family, dima, "@my_bot and me?"));
    yield* settle;
    expect(turns()).toHaveLength(1);

    // The owner in the same group: a chat of their own, no member line.
    queued.push(groupUpdate(family, owner, "@my_bot status?"));
    expect(yield* waitUntil(() => turns().length === 2)).toBe(true);
    const ownerTurn = turns()[1]!;
    expect(ownerTurn.threadId).not.toBe(annaTurn.threadId);
    expect(ownerTurn.message.text).not.toContain("not your owner");
    expect(marked).toEqual([annaTurn.threadId]);

    // Back to only me: Anna is ignored again, and stays picked for later.
    yield* telegram.setGroupAccess({ projectId, chatId: String(FAMILY), members: "owners" });
    queued.push(groupUpdate(family, anna, "@my_bot hello?"));
    yield* settle;
    expect(turns()).toHaveLength(2);
    const after = yield* telegram.groups(projectId);
    expect(after.groups[0]?.members).toBe("owners");
    expect(after.groups[0]?.people.find((p) => p.id === String(ANNA))).toMatchObject({
      selected: true,
      allowed: false,
    });
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("a group the owner called the bot in waits to be added; a stranger's does not", () =>
  Effect.gen(function* () {
    yield* saveRow(OWN, [String(OWNER)]);
    const telegram = yield* ManagerTelegramService;
    const bookClub = { id: BOOK_CLUB, title: "Book club" };

    queued.push(groupUpdate({ id: -100901, title: "Spam" }, anna, "@my_bot hi"));
    queued.push(groupUpdate(bookClub, owner, "@my_bot hi"));
    expect(yield* waitUntil(() => sent.length === 1)).toBe(true);
    yield* settle;
    expect(turns()).toEqual([]);
    // The owner hears where to add it; the stranger's group hears nothing.
    expect(sent).toEqual([
      {
        chatId: String(BOOK_CLUB),
        text: expect.stringContaining("I don't answer in this group yet"),
      },
    ]);
    const view = yield* telegram.groups(projectId);
    expect(view.groups).toEqual([]);
    expect(view.pending).toEqual([{ chatId: String(BOOK_CLUB), title: "Book club" }]);

    // Added with everyone let in: anyone there is heard now.
    const added = yield* telegram.setGroupAccess({
      projectId,
      chatId: String(BOOK_CLUB),
      members: "anyone",
    });
    expect(added.ok && added.result.pending).toEqual([]);
    queued.push(groupUpdate(bookClub, dima, "@my_bot what do we read next?"));
    expect(yield* waitUntil(() => turns().length === 1)).toBe(true);
    expect(turns()[0]!.runtimeMode).toBe("approval-required");
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("Uno's shared bot takes no groups", () =>
  Effect.gen(function* () {
    yield* saveRow(`unorelay:${TGA}`, [String(OWNER), String(FAMILY)]);
    const telegram = yield* ManagerTelegramService;
    expect((yield* telegram.groups(projectId)).supported).toBe(false);
    const outcome = yield* telegram.setGroupAccess({
      projectId,
      chatId: String(FAMILY),
      members: "anyone",
    });
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining("own bot") });
  }).pipe(Effect.provide(connectorLayer)),
);
