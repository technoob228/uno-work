import type {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildAssistantChats,
  chatEffort,
  chatStatus,
  fetchGatewayThreadUsage,
  parseGatewayThreadUsage,
  selectAssistantChats,
  tokensFromActivities,
} from "./assistantChats.ts";

const shell = (over: Record<string, unknown>) =>
  ({
    id: "t",
    projectId: "p-work",
    title: "Chat",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    latestTurn: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    createdAt: "2026-10-02T10:00:00.000Z",
    updatedAt: "2026-10-02T10:00:00.000Z",
    assistantRole: null,
    spawnedByThreadId: null,
    ...over,
  }) as unknown as OrchestrationThreadShell;

describe("which chats the assistant started", () => {
  it("create_thread (spawned) and chat_create from an assistant chat; newest first", () => {
    const threads = [
      shell({ id: "assistant-chat", projectId: "assistant-home", assistantRole: "chat" }),
      shell({ id: "a", assistantRole: "spawned", createdAt: "2026-10-02T09:00:00.000Z" }),
      shell({
        id: "b",
        spawnedByThreadId: "assistant-chat",
        createdAt: "2026-10-02T11:00:00.000Z",
      }),
      shell({ id: "c", spawnedByThreadId: "a" }),
      shell({ id: "d" }),
    ];
    expect(selectAssistantChats({ threads }).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("status, effort and tokens", () => {
    expect(chatStatus(shell({ hasPendingApprovals: true }))).toBe("waiting");
    expect(chatStatus(shell({ latestTurn: { state: "running" } }))).toBe("working");
    expect(chatStatus(shell({ latestTurn: { state: "error" } }))).toBe("failed");
    expect(chatStatus(shell({ latestTurn: { state: "completed" } }))).toBe("done");
    expect(
      chatEffort({
        instanceId: "claudeAgent",
        model: "m",
        options: [{ id: "effort", value: "high" }],
      } as never),
    ).toBe("high");
    expect(chatEffort({ instanceId: "uno", model: "m" } as never)).toBeNull();
    expect(
      tokensFromActivities([
        { kind: "context-window.updated", turnId: "1", payload: { usedTokens: 100 } },
        {
          kind: "context-window.updated",
          turnId: "1",
          payload: { usedTokens: 50, totalProcessedTokens: 300 },
        },
        { kind: "context-window.updated", turnId: "2", payload: { usedTokens: 40 } },
        { kind: "tool.updated", turnId: "2", payload: { usedTokens: 999 } },
      ]),
    ).toBe(340);
    expect(tokensFromActivities([])).toBeNull();
  });
});

describe("cost per chat", () => {
  const providers = [
    { instanceId: "uno", driver: "uno", displayName: "Uno" },
    { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Claude" },
  ] as unknown as ServerProvider[];
  const projects = [{ id: "p-work", title: "fishcode" }] as unknown as OrchestrationProjectShell[];
  const threads = [
    shell({ id: "u1", modelSelection: { instanceId: "uno", model: "uno/uno/smart" } }),
    shell({ id: "u2", modelSelection: { instanceId: "uno", model: "uno/uno/smart" } }),
    shell({ id: "c1" }),
  ];

  it("Uno AI chats get the gateway's numbers, plan chats tokens only", () => {
    const result = buildAssistantChats({
      threads,
      projects,
      providers,
      localTokens: new Map([["c1", 1200]]),
      gateway: {
        status: "metered",
        rows: [{ thread: "u1", costUsd: 0.42, requests: 3, aiHoursRequests: 0, tokens: 5000 }],
      },
    });
    expect(result.gateway).toBe("metered");
    const [u1, u2, c1] = result.chats;
    expect(u1).toMatchObject({ billing: "uno-ai", costUsd: 0.42, tokens: 5000, harness: "Uno" });
    expect(u1?.projectTitle).toBe("fishcode");
    expect(u2).toMatchObject({ billing: "uno-ai", costUsd: 0, aiHoursRequests: 0, tokens: null });
    expect(c1).toMatchObject({ billing: "plan", costUsd: null, tokens: 1200, harness: "Claude" });
  });

  it("without metering nothing is priced", () => {
    const result = buildAssistantChats({
      threads,
      projects,
      providers,
      localTokens: new Map(),
      gateway: { status: "unavailable" },
    });
    expect(result.chats.every((chat) => chat.costUsd === null)).toBe(true);
  });

  it("asks the gateway with the machine key; 404 = not on for this account", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return new Response(
        JSON.stringify({
          data: [
            {
              thread: "u1",
              cost_usd: 0.1,
              input_tokens: 10,
              output_tokens: 5,
              ai_hours_requests: 2,
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const answer = await fetchGatewayThreadUsage({
      gateway: { baseUrl: "https://gw/v1/", key: "k" },
      threadIds: ["u1", "u2"],
      fetchImpl,
    });
    expect(calls).toEqual([{ url: "https://gw/v1/usage/threads?ids=u1,u2", auth: "Bearer k" }]);
    expect(answer).toEqual({
      status: "metered",
      rows: [{ thread: "u1", costUsd: 0.1, requests: 0, aiHoursRequests: 2, tokens: 15 }],
    });
    const missing = await fetchGatewayThreadUsage({
      gateway: { baseUrl: "https://gw/v1", key: "k" },
      threadIds: ["u1"],
      fetchImpl: (async () => new Response("", { status: 404 })) as unknown as typeof fetch,
    });
    expect(missing.status).toBe("unavailable");
    expect((await fetchGatewayThreadUsage({ gateway: null, threadIds: ["u1"] })).status).toBe(
      "no-key",
    );
    expect(parseGatewayThreadUsage({ nope: 1 })).toBeNull();
  });
});
