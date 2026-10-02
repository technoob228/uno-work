import { ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepository } from "../persistence/Services/ManagerConnectorBindings.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ConnectorNotifyServiceLive } from "./Layers/ConnectorNotify.ts";
import { ManagerSlackService } from "./Layers/SlackConnector.ts";
import { ManagerTelegramService } from "./Layers/TelegramConnector.ts";
import { ConnectorNotifyService } from "./Services/ConnectorNotify.ts";

const ASSISTANT = ProjectId.make("assistant-home");

function setup() {
  const telegram: Array<{ chatId: string; text: string }> = [];
  const slack: Array<{ channelId: string; threadTs?: string; text: string }> = [];
  const layer = ConnectorNotifyServiceLive.pipe(
    Layer.provide(
      Layer.mock(ManagerConnectorBindingRepository)({
        listAll: () =>
          Effect.succeed([
            {
              kind: "slack",
              chatId: "C0TEAM:1700000000.000100",
              connectorProjectId: ASSISTANT,
              target: { kind: "thread", threadId: ThreadId.make("thread-team") },
              notifyOnComplete: false,
              updatedAt: "2026-10-02T00:00:00.000Z",
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
                    config: { botToken: "123:abc", allowedChatIds: ["100"], enabled: true },
                  },
                ] as never)
              : ([
                  {
                    projectId: ASSISTANT,
                    config: {
                      botToken: "xoxb-1",
                      appToken: "xapp-1",
                      allowedChannelIds: ["C0TEAM", "D0OWNER"],
                      enabled: true,
                    },
                  },
                ] as never),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.succeed({ threads: [], projects: [] } as never),
        getThreadShellById: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagerTelegramService)({
        sendText: (input) =>
          Effect.sync(() => {
            telegram.push({ chatId: input.chatId, text: input.text });
            return true;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ManagerSlackService)({
        sendText: (input) =>
          Effect.sync(() => {
            slack.push({
              channelId: input.channelId,
              text: input.text,
              ...(input.threadTs ? { threadTs: input.threadTs } : {}),
            });
            return true;
          }),
      }),
    ),
  );
  const run = <A>(use: (service: typeof ConnectorNotifyService.Service) => Effect.Effect<A>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* ConnectorNotifyService);
      }).pipe(Effect.provide(layer)),
    );
  return { telegram, slack, run };
}

describe("notify reaches Slack", () => {
  it("notify (alsoMessenger) goes to Telegram and the owner's Slack DM", async () => {
    const { telegram, slack, run } = setup();
    const result = await run((service) =>
      service.notify({ text: "Report is ready", projectId: ASSISTANT, kind: "info" } as never),
    );
    expect(result.delivered).toBe(2);
    expect(telegram.map((entry) => entry.chatId)).toEqual(["100"]);
    expect(slack.map((entry) => entry.channelId)).toEqual(["D0OWNER"]);
  });

  it("a Slack thread bound to the thread gets it in that Slack thread", async () => {
    const { slack, run } = setup();
    await run((service) =>
      service.notify({
        text: "Done",
        threadId: ThreadId.make("thread-team"),
        kind: "info",
      } as never),
    );
    expect(slack).toEqual([
      expect.objectContaining({ channelId: "C0TEAM", threadTs: "1700000000.000100" }),
    ]);
  });

  it("the events forwarder path (no includeSlack) stays Telegram-only", async () => {
    const { run } = setup();
    const chats = await run((service) =>
      service.resolveChats({
        threadId: ThreadId.make("thread-team"),
        projectId: null,
        includeAssistantFallback: false,
      }),
    );
    expect(chats).toEqual([]);
  });
});
