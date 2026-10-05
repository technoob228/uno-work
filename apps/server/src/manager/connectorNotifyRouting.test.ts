/**
 * Where `notify` goes since 05.10: the assistant speaks in its own bot; Uno's
 * service notifications (another chat's agent, an app) go to Uno's own bot
 * through the console (`notify-owner`), never into the assistant's bot.
 */
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepository } from "../persistence/Services/ManagerConnectorBindings.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ConnectorNotifyServiceLive } from "./Layers/ConnectorNotify.ts";
import { ManagerSlackService } from "./Layers/SlackConnector.ts";
import { ManagerTelegramService } from "./Layers/TelegramConnector.ts";
import { ConnectorNotifyService } from "./Services/ConnectorNotify.ts";
import { UNO_SERVICE_CHAT_ID } from "./unoServiceNotify.ts";

const ASSISTANT = ProjectId.make("assistant-home");
const SITE_PROJECT = ProjectId.make("project-site");
const MAIN_CHAT = ThreadId.make("thread-uno");
const SITE_CHAT = ThreadId.make("thread-site");

function setup(input: { readonly cloud: boolean; readonly consoleSent?: boolean }) {
  const telegram: Array<{ chatId: string; text: string }> = [];
  const console: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    console.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Response(
      JSON.stringify({ linked: input.consoleSent ?? true, sent: input.consoleSent ?? true }),
      { status: 200 },
    );
  });
  const layer = ConnectorNotifyServiceLive.pipe(
    Layer.provide(
      Layer.mock(ManagerConnectorBindingRepository)({
        listAll: () =>
          Effect.succeed([
            {
              kind: "telegram",
              chatId: "100",
              connectorProjectId: ASSISTANT,
              target: { kind: "thread", threadId: MAIN_CHAT },
              notifyOnComplete: false,
              updatedAt: "2026-10-05T00:00:00.000Z",
            },
          ] as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagerConnectorRepository)({
        listByKind: (kind) =>
          Effect.succeed(
            kind === "telegram"
              ? ([
                  {
                    projectId: ASSISTANT,
                    config: {
                      botToken: "123456:AAEownbottokenownbottoken",
                      allowedChatIds: ["100"],
                      enabled: true,
                    },
                  },
                ] as never)
              : ([] as never),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            threads: [
              {
                id: MAIN_CHAT,
                projectId: ASSISTANT,
                assistantRole: "chat",
                archivedAt: null,
                deletedAt: null,
              },
            ],
            projects: [],
          } as never),
        getThreadShellById: (threadId) =>
          Effect.succeed(
            threadId === SITE_CHAT
              ? Option.some({ id: SITE_CHAT, projectId: SITE_PROJECT } as never)
              : threadId === MAIN_CHAT
                ? Option.some({ id: MAIN_CHAT, projectId: ASSISTANT } as never)
                : Option.none(),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagerTelegramService)({
        sendText: (message) =>
          Effect.sync(() => {
            telegram.push({ chatId: message.chatId, text: message.text });
            return true;
          }),
      }),
    ),
    Layer.provide(Layer.mock(ManagerSlackService)({ sendText: () => Effect.succeed(true) })),
    Layer.provide(
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed(
          (input.cloud ? { uno: { boxToken: "uno_agt_machine", boxId: 10 } } : {}) as never,
        ),
      }),
    ),
  );
  const run = <A>(use: (service: typeof ConnectorNotifyService.Service) => Effect.Effect<A>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* ConnectorNotifyService);
      }).pipe(Effect.provide(layer)),
    );
  return { telegram, console, run };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("notify: the assistant's bot is the assistant's", () => {
  it("another chat's agent: Uno's bot through the console, not the assistant's bot", async () => {
    const { telegram, console, run } = setup({ cloud: true });
    const result = await run((service) =>
      service.notify({ text: "Site is ready", threadId: SITE_CHAT, kind: "info" } as never),
    );
    expect(telegram).toEqual([]);
    expect(console).toHaveLength(1);
    expect(console[0]!.url).toMatch(/\/api\/v1\/boxes\/10\/work\/notify-owner$/);
    expect(console[0]!.body).toEqual({ text: expect.stringContaining("Site is ready") });
    expect(result).toEqual({
      delivered: 1,
      chats: [{ kind: "telegram", chatId: UNO_SERVICE_CHAT_ID, delivered: true }],
    });
  });

  it("an app with no thread: Uno's bot too", async () => {
    const { telegram, console, run } = setup({ cloud: true });
    await run((service) => service.notify({ text: "Backup failed", kind: "error" } as never));
    expect(telegram).toEqual([]);
    expect(console).toHaveLength(1);
  });

  it("not linked to Telegram at Uno, or a laptop: the Inbox only", async () => {
    const notLinked = setup({ cloud: true, consoleSent: false });
    const result = await notLinked.run((service) =>
      service.notify({ text: "Site is ready", threadId: SITE_CHAT } as never),
    );
    expect(result.delivered).toBe(0);
    expect(notLinked.telegram).toEqual([]);
    vi.restoreAllMocks();

    const laptop = setup({ cloud: false });
    await laptop.run((service) =>
      service.notify({ text: "Site is ready", threadId: SITE_CHAT } as never),
    );
    expect(laptop.console).toEqual([]);
    expect(laptop.telegram).toEqual([]);
  });

  it("the assistant itself: its own bot, not Uno's", async () => {
    const { telegram, console, run } = setup({ cloud: true });
    await run((service) =>
      service.notify({ text: "Plan for today", threadId: MAIN_CHAT, kind: "info" } as never),
    );
    expect(telegram.map((entry) => entry.chatId)).toEqual(["100"]);
    expect(console).toEqual([]);
  });
});
