/**
 * The App API sends an app's answers to the provider the person chose for it
 * (Uno gateway / AI on this computer / own key) without the app changing: the
 * limit is only Uno AI's, a key never leaves the daemon, errors say which
 * provider failed.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AppAiRouteResult } from "./appAiProviders.ts";
import { type AppApiCaller, type AppApiCore, makeAppApiHandler } from "./appApiHttp.ts";

const caller = (over: Partial<AppApiCaller> = {}): AppApiCaller => ({
  appId: "notes",
  appName: "Notes",
  chat: true,
  tasks: false,
  limitUsd: 1,
  spentUsd: 0,
  tasksSpentUsd: 0,
  manifestCwd: null,
  taskToolsCap: "edit",
  storage: null,
  ...over,
});

interface Seen {
  readonly server: string;
  readonly url: string;
  readonly auth: string | undefined;
  readonly body: Record<string, unknown>;
}
const seen: Seen[] = [];

function fakeOpenAi(name: string, options: { models: string[]; failWith?: number }) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      seen.push({ server: name, url: req.url ?? "", auth: req.headers["authorization"], body });
      if (options.failWith) {
        res.writeHead(options.failWith, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-or-secret" } }));
        return;
      }
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: options.models.map((id) => ({ id })) }));
        return;
      }
      if (req.url?.endsWith("/audio/transcriptions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: `heard by ${name}`, duration: 10 }));
        return;
      }
      if (body["stream"] === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `hi from ${name}` } }] })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: `hi from ${name}` } }],
          usage: { prompt_tokens: 1000, completion_tokens: 1000 },
        }),
      );
    });
  });
}

const servers: Record<string, http.Server> = {};
const urls: Record<string, string> = {};
let api: http.Server;
let apiUrl = "";
let route: () => AppAiRouteResult = () => ({ ok: false, status: 500, code: "x", message: "x" });
let current = caller();
const charges: Array<{ appId: string; usd: number }> = [];

const listen = (server: http.Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );

beforeAll(async () => {
  servers.gateway = fakeOpenAi("gateway", { models: ["m1"] });
  servers.local = fakeOpenAi("local", { models: ["qwen3:4b", "llama3"] });
  servers.byok = fakeOpenAi("byok", { models: ["gpt-x"] });
  servers.byokBad = fakeOpenAi("byokBad", { models: [], failWith: 401 });
  servers.empty = fakeOpenAi("empty", { models: [] });
  for (const [name, server] of Object.entries(servers)) urls[name] = `${await listen(server)}/v1`;
  const core: AppApiCore = {
    home: "/home/unowork",
    authenticate: async (token) => (token === "uno_app_notes" ? current : null),
    gateway: async () => ({ baseUrl: urls.gateway!, key: "unollm_machine" }),
    defaults: async () => ({ chatModel: "m1", taskHarness: null }),
    prices: async () => new Map([["m1", { prompt: 0.001, completion: 0.002 }]]),
    charge: async (appId, usd) => {
      charges.push({ appId, usd });
    },
    route: async () => route(),
    createTask: async () => ({ reply: { status: 500, body: {} }, task: null }),
    findTask: () => undefined,
    listTasks: () => [],
    viewTask: async () => {
      throw new Error("no");
    },
    taskDetail: async () => null,
    stopTask: async () => false,
  };
  const handler = makeAppApiHandler(core);
  api = http.createServer((req, res) => void handler(req, res));
  apiUrl = await listen(api);
});

afterAll(() => {
  api.close();
  for (const server of Object.values(servers)) server.close();
});

beforeEach(() => {
  seen.length = 0;
  charges.length = 0;
  current = caller();
});

const local = (model: string | null = null, baseUrl?: string): AppAiRouteResult => ({
  ok: true,
  route: {
    kind: "local",
    baseUrl: baseUrl ?? urls.local!,
    apiKey: null,
    headers: {},
    metered: false,
    defaultModel: model,
    label: "Ollama on this computer",
  },
});
const gateway = (): AppAiRouteResult => ({
  ok: true,
  route: {
    kind: "uno",
    baseUrl: urls.gateway!,
    apiKey: "unollm_machine",
    headers: {},
    metered: true,
    defaultModel: "m1",
    label: "Uno AI",
  },
});
const byok = (url: string): AppAiRouteResult => ({
  ok: true,
  route: {
    kind: "byok",
    baseUrl: url,
    apiKey: "sk-or-secret",
    headers: {},
    metered: false,
    defaultModel: "gpt-x",
    label: "OpenRouter (your key)",
  },
});

const chat = (body: Record<string, unknown> = {}) =>
  fetch(`${apiUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer uno_app_notes", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }),
  });

describe("App API provider routing", () => {
  it("gateway: machine key, charged, the limit applies", async () => {
    route = gateway;
    const response = await chat();
    expect(response.status).toBe(200);
    expect(seen[0]).toMatchObject({ server: "gateway", auth: "Bearer unollm_machine" });
    expect(charges[0]!.usd).toBeGreaterThan(0);
    current = caller({ spentUsd: 1 });
    expect((await chat()).status).toBe(402);
  });

  it("local: no key sent, no charge, the limit doesn't apply, first model when none chosen", async () => {
    route = () => local(null);
    current = caller({ spentUsd: 5 });
    const response = await chat({ stream: true });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hi from local");
    const call = seen.find((s) => s.url.endsWith("/chat/completions"))!;
    expect(call.auth).toBeUndefined();
    expect(call.body["model"]).toBe("qwen3:4b");
    expect(call.body["stream_options"]).toBeUndefined();
    expect(charges).toEqual([{ appId: "notes", usd: 0 }]);
  });

  it("an explicit model from the app wins over the chosen default", async () => {
    route = () => local("qwen3:4b");
    await chat({ model: "llama3" });
    expect(seen.find((s) => s.url.endsWith("/chat/completions"))!.body["model"]).toBe("llama3");
  });

  it("own key: the key goes to the provider, a refusal comes back without its body", async () => {
    route = () => byok(urls.byok!);
    expect((await chat()).status).toBe(200);
    expect(seen[0]).toMatchObject({ server: "byok", auth: "Bearer sk-or-secret" });
    route = () => byok(urls.byokBad!);
    const refused = await chat();
    expect(refused.status).toBe(401);
    const text = await refused.text();
    expect(text).not.toContain("sk-or-secret");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "provider_error" } });
  });

  it("a server that isn't running and one without models say so plainly", async () => {
    route = () => local("x", "http://127.0.0.1:9/v1");
    const down = await chat();
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ error: { code: "provider_unreachable" } });
    route = () => local(null, urls.empty!);
    const empty = await chat();
    expect(empty.status).toBe(503);
    expect(await empty.json()).toMatchObject({ error: { code: "no_model" } });
  });

  it("/v1/models lists the chosen provider's models", async () => {
    route = () => local(null);
    const response = await fetch(`${apiUrl}/v1/models`, {
      headers: { authorization: "Bearer uno_app_notes" },
    });
    expect(await response.json()).toEqual({ data: [{ id: "qwen3:4b" }, { id: "llama3" }] });
  });

  it("whoami tells the app where its answers go", async () => {
    route = () => local("qwen3:4b");
    const response = await fetch(`${apiUrl}/v1/whoami`, {
      headers: { authorization: "Bearer uno_app_notes" },
    });
    expect(await response.json()).toMatchObject({
      provider: {
        kind: "local",
        label: "Ollama on this computer",
        model: "qwen3:4b",
        metered: false,
      },
      defaults: { chatModel: "qwen3:4b" },
    });
  });

  it("speech-to-text stays on Uno AI for a local provider and follows an own key", async () => {
    const form = () => {
      const data = new FormData();
      data.append("file", new Blob([new Uint8Array(100)]), "a.wav");
      return data;
    };
    const transcribe = () =>
      fetch(`${apiUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: "Bearer uno_app_notes" },
        body: form(),
      });
    route = () => local("qwen3:4b");
    expect(await (await transcribe()).json()).toEqual({ text: "heard by gateway", duration: 10 });
    expect(charges[0]!.usd).toBeGreaterThan(0);
    charges.length = 0;
    route = () => byok(urls.byok!);
    expect(await (await transcribe()).json()).toEqual({ text: "heard by byok", duration: 10 });
    expect(charges).toEqual([]);
  });
});
