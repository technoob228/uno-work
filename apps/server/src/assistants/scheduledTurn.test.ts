import { ManagerTokenId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ConnectorNotifyService } from "../manager/Services/ConnectorNotify.ts";
import type { ManagerCaller } from "../manager/Services/ManagerToolService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import {
  AssistantScheduledTurns,
  SCHEDULED_THREAD_TITLE,
  isNoReply,
  makeAssistantScheduledTurns,
  wrapScheduledPrompt,
} from "./scheduledTurn.ts";

const caller = (label: string): ManagerCaller => ({
  tokenId: ManagerTokenId.make("tok-1"),
  scopes: ["threads:read", "threads:write"],
  projectAllowlist: "all",
  budget: null,
  autoApprove: true,
  label,
});

const MAIN = ThreadId.make("thread-main");

interface World {
  readonly dispatched: Array<Record<string, unknown>>;
  readonly sent: Array<{ chats: number; text: string }>;
  readonly resolveInputs: Array<Record<string, unknown>>;
  reply: string | null;
}

function makeLayer(world: World, options: { mainChat: boolean; projectId: string }) {
  let requestedAt: string | null = null;
  let requestedMessageId: string | null = null;
  const threads = options.mainChat
    ? [
        {
          id: MAIN,
          projectId: ProjectId.make("assistant-home"),
          title: "Uno",
          assistantRole: "chat",
          archivedAt: null,
          runtimeMode: "full-access",
          interactionMode: "default",
        },
      ]
    : [];
  return Layer.effect(AssistantScheduledTurns, makeAssistantScheduledTurns({ pollMs: 1 })).pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            threads,
            projects: [{ id: ProjectId.make(options.projectId) }],
          } as never),
        getThreadShellById: (threadId) =>
          Effect.succeed(
            Option.fromNullishOr(threads.find((thread) => thread.id === threadId) as never),
          ),
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              session: { status: "ready", activeTurnId: null, updatedAt: requestedAt },
              activities: [],
              messages:
                requestedAt !== null && world.reply !== null
                  ? [
                      {
                        id: "answer-1",
                        role: "assistant",
                        text: world.reply,
                        turnId: "turn-1",
                        streaming: false,
                        createdAt: new Date(Date.parse(requestedAt) + 10).toISOString(),
                        updatedAt: new Date(Date.parse(requestedAt) + 10).toISOString(),
                      },
                    ]
                  : [],
            } as never),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionTurnRepository)({
        listByThreadId: () =>
          Effect.succeed(
            requestedAt === null
              ? []
              : ([
                  {
                    turnId: "turn-1",
                    pendingMessageId: requestedMessageId,
                    state: "completed",
                    requestedAt,
                    completedAt: requestedAt,
                  },
                ] as never),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            world.dispatched.push(command as never);
            if ((command as { type: string }).type === "thread.turn.start") {
              requestedAt = (command as { createdAt: string }).createdAt;
              requestedMessageId = (command as { message: { messageId: string } }).message
                .messageId;
            }
            return { sequence: world.dispatched.length };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ConnectorNotifyService)({
        resolveChats: (input) =>
          Effect.sync(() => {
            world.resolveInputs.push(input as never);
            return [
              {
                kind: "telegram",
                connectorProjectId: ProjectId.make("assistant-home"),
                chatId: "100",
                notifyOnComplete: false,
                via: "assistant",
              },
            ];
          }),
        sendToChats: (chats, text) =>
          Effect.sync(() => {
            world.sent.push({ chats: chats.length, text });
            return { delivered: chats.length, chats: [] };
          }),
      }),
    ),
  );
}

const runTurn = (world: World, options: { mainChat: boolean; projectId: string }, label: string) =>
  Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const turns = yield* AssistantScheduledTurns;
        return yield* turns.run(caller(label), {
          prompt: "Collect mentions",
          name: "Digest",
          timeoutSec: 30,
        });
      }).pipe(Effect.provide(makeLayer(world, options))),
    ),
  );

const freshWorld = (reply: string | null): World => ({
  dispatched: [],
  sent: [],
  resolveInputs: [],
  reply,
});

describe("scheduled assistant turn", () => {
  it("frames the prompt and recognises NO_REPLY", () => {
    const text = wrapScheduledPrompt({ name: "Digest", prompt: "Collect mentions" });
    expect(text).toContain('Scheduled task "Digest"');
    expect(text).toContain("NO_REPLY");
    expect(text.endsWith("Collect mentions")).toBe(true);
    expect(isNoReply(" no_reply. ")).toBe(true);
    expect(isNoReply("No reply needed, all good")).toBe(false);
  });

  it("runs in the main conversation and delivers the answer to the person's chats", async () => {
    const world = freshWorld("3 new mentions, draft is in Notion.");
    const result = await runTurn(
      world,
      { mainChat: true, projectId: "assistant-home" },
      "assistant:assistant-home",
    );
    expect(result).toMatchObject({
      _tag: "Success",
      success: { status: "delivered", threadId: MAIN, delivered: 1 },
    });
    const start = world.dispatched.find((command) => command.type === "thread.turn.start");
    expect(start?.threadId).toBe(MAIN);
    expect(start?.runtimeMode).toBe("full-access");
    expect(world.dispatched.some((command) => command.type === "thread.create")).toBe(false);
    expect(world.sent).toEqual([
      { chats: 1, text: "⏰ Digest\n\n3 new mentions, draft is in Notion." },
    ]);
    expect(world.resolveInputs[0]).toMatchObject({
      includeSlack: true,
      includeAssistantFallback: true,
    });
  });

  it("stays silent on NO_REPLY", async () => {
    const world = freshWorld("NO_REPLY");
    const result = await runTurn(
      world,
      { mainChat: true, projectId: "assistant-home" },
      "assistant:assistant-home",
    );
    expect(result).toMatchObject({ _tag: "Success", success: { status: "no_reply" } });
    expect(world.sent).toEqual([]);
  });

  it("gives another assistant its own Scheduled tasks thread", async () => {
    const world = freshWorld("ok");
    const result = await runTurn(
      world,
      { mainChat: false, projectId: "assistant-liza" },
      "assistant:assistant-liza",
    );
    expect(result._tag).toBe("Success");
    const create = world.dispatched.find((command) => command.type === "thread.create");
    expect(create).toMatchObject({
      projectId: "assistant-liza",
      title: SCHEDULED_THREAD_TITLE,
      runtimeMode: "full-access",
    });
  });

  it("refuses a token that is not an assistant's", async () => {
    const world = freshWorld("ok");
    const result = await runTurn(world, { mainChat: true, projectId: "assistant-home" }, "ci-bot");
    expect(result).toMatchObject({ _tag: "Failure", failure: { status: 403 } });
    expect(world.dispatched).toEqual([]);
  });
});
