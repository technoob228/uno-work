import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StoredAppTask } from "./appAiStore.ts";
import { type AppApiCaller, type AppApiCore, makeAppApiHandler } from "./appApiHttp.ts";
import type { AppTaskView } from "./appTasks.ts";

const TOKENS: Record<string, AppApiCaller> = {
  uno_app_notes: {
    appId: "notes",
    appName: "Notes",
    chat: true,
    tasks: true,
    limitUsd: 10,
    spentUsd: 0,
    manifestCwd: null,
    taskToolsCap: "edit",
  },
  uno_app_other: {
    appId: "other",
    appName: "Other",
    chat: true,
    tasks: true,
    limitUsd: 10,
    spentUsd: 0,
    manifestCwd: null,
    taskToolsCap: "edit",
  },
  uno_app_notasks: {
    appId: "notasks",
    appName: "No tasks",
    chat: true,
    tasks: false,
    limitUsd: 10,
    spentUsd: 0,
    manifestCwd: null,
    taskToolsCap: "edit",
  },
  uno_app_broke: {
    appId: "broke",
    appName: "Broke",
    chat: true,
    tasks: true,
    limitUsd: 1,
    spentUsd: 1,
    manifestCwd: null,
    taskToolsCap: "edit",
  },
};

const charges: Array<{ appId: string; usd: number }> = [];
const gatewayRequests: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
const tasks = new Map<string, StoredAppTask[]>([
  [
    "other",
    [
      {
        id: "task_other1",
        threadId: "thread-other",
        createdAt: "2026-09-23T00:00:00.000Z",
        tools: "ask",
        harness: "uno",
        turnCountAtStart: 0,
      },
    ],
  ],
]);

const view = (task: StoredAppTask): AppTaskView => ({
  id: task.id,
  threadId: task.threadId,
  status: "done",
  tools: task.tools,
  harness: task.harness,
  createdAt: task.createdAt,
  result: { text: "done" },
  changedFiles: ["summary.md"],
  waitingFor: null,
  error: null,
});

let gateway: http.Server;
let api: http.Server;
let gatewayUrl = "";
let apiUrl = "";

beforeAll(async () => {
  gateway = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      gatewayRequests.push({ auth: req.headers["authorization"], body });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [{ id: "m1", pricing: { prompt: "0.000001", completion: "0.000002" } }],
          }),
        );
        return;
      }
      if (body["stream"] === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1000,',
        );
        res.end('"completion_tokens":500}}\n\ndata: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Hello" } }],
          usage: { prompt_tokens: 1000, completion_tokens: 1000 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`;

  const core: AppApiCore = {
    home: "/home/unowork",
    authenticate: async (token) => TOKENS[token] ?? null,
    gateway: async () => ({ baseUrl: gatewayUrl, key: "unollm_machine" }),
    defaults: async () => ({ chatModel: "m1", taskHarness: "uno" }),
    prices: async () => new Map([["m1", { prompt: 0.000001, completion: 0.000002 }]]),
    charge: async (appId, usd) => {
      charges.push({ appId, usd });
    },
    createTask: async (caller) => {
      const task: StoredAppTask = {
        id: `task_${caller.appId}`,
        threadId: `thread-${caller.appId}`,
        createdAt: new Date().toISOString(),
        tools: "ask",
        harness: "uno",
        turnCountAtStart: 0,
      };
      tasks.set(caller.appId, [task, ...(tasks.get(caller.appId) ?? [])]);
      return { reply: { status: 202, body: { id: task.id } }, task };
    },
    findTask: (appId, taskId) => tasks.get(appId)?.find((t) => t.id === taskId),
    listTasks: (appId) => tasks.get(appId) ?? [],
    viewTask: async (task) => view(task),
    taskDetail: async () => ({
      messages: [{ id: "m", role: "assistant", text: "Summary ready" }],
      activities: [{ id: "a1", tone: "tool", kind: "tool.completed", summary: "Read a.txt" }],
    }),
    stopTask: async () => true,
  };
  const handler = makeAppApiHandler(core);
  api = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(() => {
  gateway.close();
  api.close();
});

const call = (path: string, token: string | null, init: RequestInit = {}) =>
  fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });

describe("App API", () => {
  it("answers health without a token and nothing else", async () => {
    expect((await call("/health", null)).status).toBe(200);
    const res = await call("/v1/whoami", null);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_app_token",
    );
    expect((await call("/v1/whoami", "uno_app_forged")).status).toBe(401);
  });

  it("whoami tells the app who it is and what is left", async () => {
    const body = (await (await call("/v1/whoami", "uno_app_notes")).json()) as {
      app: { id: string };
      ai: { remainingUsd: number };
    };
    expect(body.app.id).toBe("notes");
    expect(body.ai.remainingUsd).toBe(10);
  });

  it("forwards chat with the machine key, fills the default model and charges the app", async () => {
    charges.length = 0;
    const res = await call("/v1/chat/completions", "uno_app_notes", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const last = gatewayRequests.at(-1);
    expect(last?.auth).toBe("Bearer unollm_machine");
    expect(last?.body["model"]).toBe("m1");
    expect(charges).toEqual([{ appId: "notes", usd: 1000 * 0.000001 + 1000 * 0.000002 }]);
  });

  it("streams SSE through untouched and charges from the usage chunk", async () => {
    charges.length = 0;
    const res = await call("/v1/chat/completions", "uno_app_notes", {
      method: "POST",
      body: JSON.stringify({
        model: "default",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const text = await res.text();
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("Hel");
    expect(text).toContain("[DONE]");
    const options = gatewayRequests.at(-1)?.body["stream_options"] as
      | { include_usage: boolean }
      | undefined;
    expect(options?.include_usage).toBe(true);
    expect(charges[0]?.usd).toBeCloseTo(1000 * 0.000001 + 500 * 0.000002, 10);
  });

  it("refuses an app over its limit with 402 before touching the gateway", async () => {
    const before = gatewayRequests.length;
    const res = await call("/v1/chat/completions", "uno_app_broke", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "app_limit_reached",
    );
    expect(gatewayRequests.length).toBe(before);
  });

  it("tasks need the manifest's permission", async () => {
    const res = await call("/v1/tasks", "uno_app_notasks", {
      method: "POST",
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("an app never sees another app's task", async () => {
    expect((await call("/v1/tasks/task_other1", "uno_app_notes")).status).toBe(404);
    expect(
      (await call("/v1/tasks/task_other1/stop", "uno_app_notes", { method: "POST" })).status,
    ).toBe(404);
    expect((await call("/v1/tasks/task_other1/events", "uno_app_notes")).status).toBe(404);
    expect((await call("/v1/tasks/task_other1", "uno_app_other")).status).toBe(200);
    const list = (await (await call("/v1/tasks", "uno_app_notes")).json()) as { tasks: unknown[] };
    expect(list.tasks.every((t) => (t as { id: string }).id !== "task_other1")).toBe(true);
  });

  it("creates a task and streams its progress as SSE", async () => {
    const created = await call("/v1/tasks", "uno_app_notes", {
      method: "POST",
      body: JSON.stringify({ prompt: "Summarise ~/Inbox" }),
    });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    const events = await (await call(`/v1/tasks/${id}/events`, "uno_app_notes")).text();
    expect(events).toContain("event: status");
    expect(events).toContain("event: activity");
    expect(events).toContain('"delta":"Summary ready"');
    expect(events).toContain("event: done");
  });
});
