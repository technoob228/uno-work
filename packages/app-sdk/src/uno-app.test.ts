import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { UnoAppError, createClient, parseSSE, resolveConfig } from "@uno4/app";
import type { TaskEvent } from "@uno4/app";

const TOKEN = "uno_app_test";

interface Seen {
  method: string;
  url: string;
  auth: string;
  body: string;
  contentType: string;
}

const seen: Seen[] = [];
let taskPolls = 0;
let server: http.Server;
let url = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function writeChunks(res: http.ServerResponse, chunks: Array<string | Buffer>) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) {
    res.write(c);
    await sleep(5);
  }
  res.end();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization ?? "",
        body,
        contentType: req.headers["content-type"] ?? "",
      });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return send(res, 401, {
          error: { type: "auth", code: "invalid_app_token", message: "bad token" },
        });
      }
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/v1/chat/completions") {
        const json = JSON.parse(body);
        if (json.messages?.[0]?.content === "over") {
          return send(res, 402, {
            error: {
              type: "limit",
              code: "app_limit_reached",
              message: "This app spent its limit",
            },
          });
        }
        if (json.messages?.[0]?.content === "gw") {
          // The gateway's shape: machine code in `type`, HTTP status in `code`.
          return send(res, 402, {
            error: { type: "key_limit_reached", code: 402, message: "key limit" },
          });
        }
        if (json.stream) {
          // "Привет, мир" split across chunk boundaries, incl. inside a multi-byte char.
          const e1 = `data: ${JSON.stringify({ choices: [{ delta: { content: "Привет" } }] })}\n\n`;
          const e2 = `data: ${JSON.stringify({ choices: [{ delta: { content: ", мир" } }] })}\r\n\r\n`;
          const b1 = Buffer.from(e1);
          const b2 = Buffer.from(e2);
          return void writeChunks(res, [
            b1.subarray(0, 10),
            b1.subarray(10, 31),
            Buffer.concat([b1.subarray(31), b2.subarray(0, 3)]),
            b2.subarray(3),
            ": keep-alive\n\n",
            `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\n`,
            "data: [DO",
            "NE]\n\n",
            `data: ${JSON.stringify({ choices: [{ delta: { content: "never" } }] })}\n\n`,
          ]);
        }
        return send(res, 200, {
          model: json.model,
          choices: [{ message: { role: "assistant", content: `echo:${json.model}` } }],
        });
      }
      if (u.pathname === "/v1/audio/transcriptions") {
        return send(res, 200, { text: "hello from audio" });
      }
      if (u.pathname === "/v1/whoami") {
        return send(res, 200, { app: { id: "t", name: "T" } });
      }
      if (u.pathname === "/v1/tasks" && req.method === "POST") {
        taskPolls = 0;
        return send(res, 202, {
          id: "task_1",
          threadId: "th_1",
          status: "running",
          tools: "edit",
          harness: "uno",
        });
      }
      if (u.pathname === "/v1/tasks/task_1") {
        taskPolls++;
        const status = taskPolls === 1 ? "running" : taskPolls === 2 ? "waiting" : "done";
        return send(res, 200, {
          id: "task_1",
          threadId: "th_1",
          status,
          result: status === "done" ? { text: "all done" } : null,
          changedFiles: status === "done" ? ["summary.md"] : [],
          waitingFor: status === "waiting" ? "approval" : null,
        });
      }
      if (u.pathname === "/v1/tasks/task_1/events") {
        return void writeChunks(res, [
          'event: status\ndata: {"status":"running"}\n\n',
          'event: message\ndata: {"delta":"Reading 4 ',
          'files…"}\n\nevent: activity\ndata: {"kind":"tool","summary":"Read a.txt"}\n\n',
          'event: done\ndata: {"status":"done","result":{"text":"ok"}}\n\n',
          'event: status\ndata: {"status":"after"}\n\n',
        ]);
      }
      if (u.pathname === "/v1/tasks/task_1/stop") {
        return send(res, 200, { id: "task_1", status: "stopped" });
      }
      send(res, 404, { error: { type: "not_found", code: "not_found", message: "nope" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const ENV_KEYS = ["UNO_APP_API_URL", "UNO_APP_TOKEN", "UNO_APP_KEY_DIR", "UNO_APP_ID"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("chat", () => {
  it("ask sends model default + system and returns the text", async () => {
    const c = createClient({ url, token: TOKEN });
    const text = await c.ask("hi", { system: "be brief", maxTokens: 20, temperature: 0 });
    expect(text).toBe("echo:default");
    const req = seen.at(-1)!;
    expect(req.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(req.body)).toEqual({
      model: "default",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      temperature: 0,
      max_tokens: 20,
    });
    expect(await c.ask([{ role: "user", content: "x" }], { model: "m/1" })).toBe("echo:m/1");
  });

  it("stream yields deltas across chunk boundaries and stops at [DONE]", async () => {
    const c = createClient({ url, token: TOKEN });
    const out: string[] = [];
    for await (const d of c.stream("tell")) out.push(d);
    expect(out).toEqual(["Привет", ", мир"]);
    expect(JSON.parse(seen.at(-1)!.body).stream).toBe(true);
  });

  it("maps 402 app_limit_reached to UnoAppError", async () => {
    const c = createClient({ url, token: TOKEN });
    const err = await c.ask("over").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnoAppError);
    expect(err).toMatchObject({
      status: 402,
      code: "app_limit_reached",
      message: "This app spent its limit",
    });
  });

  it("takes the code from `type` when `code` is the HTTP status (gateway shape)", async () => {
    const c = createClient({ url, token: TOKEN });
    await expect(c.ask("gw")).rejects.toMatchObject({ status: 402, code: "key_limit_reached" });
  });

  it("maps 401 invalid_app_token", async () => {
    const c = createClient({ url, token: "wrong" });
    await expect(c.whoami()).rejects.toMatchObject({ status: 401, code: "invalid_app_token" });
  });

  it("transcribe posts multipart and returns text", async () => {
    const c = createClient({ url, token: TOKEN });
    const text = await c.transcribe(new Uint8Array([1, 2, 3]), {
      filename: "a.ogg",
      language: "en",
    });
    expect(text).toBe("hello from audio");
    const req = seen.at(-1)!;
    expect(req.contentType).toMatch(/^multipart\/form-data/);
    expect(req.body).toContain('filename="a.ogg"');
    expect(req.body).toContain('name="language"');
  });
});

describe("tasks", () => {
  it("task → wait keeps waiting through 'waiting' → done", async () => {
    const c = createClient({ url, token: TOKEN });
    const t = await c.task({ prompt: "sum up", cwd: "~/Inbox", tools: "edit" });
    expect(t).toMatchObject({ id: "task_1", threadId: "th_1", status: "running", harness: "uno" });
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({
      prompt: "sum up",
      cwd: "~/Inbox",
      tools: "edit",
    });
    const done = await t.wait();
    expect(done.status).toBe("done");
    expect(done.result?.text).toBe("all done");
    expect(t.status).toBe("done");
    expect(seen.at(-1)!.url).toBe("/v1/tasks/task_1?waitMs=30000");
  });

  it("wait({untilDone:false}) returns on 'waiting'", async () => {
    const c = createClient({ url, token: TOKEN });
    const t = await c.task({ prompt: "x" });
    const s = await t.wait({ untilDone: false });
    expect(s.status).toBe("waiting");
    expect(s.waitingFor).toBe("approval");
  });

  it("events() parses SSE and ends at done; stop() works", async () => {
    const c = createClient({ url, token: TOKEN });
    const t = await c.task({ prompt: "x" });
    const evs: TaskEvent[] = [];
    for await (const e of t.events()) evs.push(e);
    expect(evs.map((e) => e.event)).toEqual(["status", "message", "activity", "done"]);
    expect(evs[1]!.data).toEqual({ delta: "Reading 4 files…" });
    await t.stop();
    expect(t.status).toBe("stopped");
  });
});

describe("config", () => {
  it("reads env UNO_APP_API_URL + UNO_APP_TOKEN", async () => {
    process.env.UNO_APP_API_URL = `${url}/`;
    process.env.UNO_APP_TOKEN = TOKEN;
    const c = createClient();
    expect(await c.config()).toMatchObject({ url, token: TOKEN, source: "env" });
    expect(await c.whoami()).toEqual({ app: { id: "t", name: "T" } });
  });

  it("reads a key dir with api.json + token", async () => {
    delete process.env.UNO_APP_API_URL;
    delete process.env.UNO_APP_TOKEN;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uno-app-"));
    fs.writeFileSync(
      path.join(dir, "api.json"),
      JSON.stringify({ appId: "notes", url, dockerUrl: "http://host.docker.internal:3779" }),
    );
    fs.writeFileSync(path.join(dir, "token"), `${TOKEN}\n`);
    process.env.UNO_APP_KEY_DIR = dir;
    const c = createClient();
    const cfg = await c.config();
    expect(cfg).toMatchObject({ token: TOKEN, appId: "notes", source: dir });
    if (!fs.existsSync("/.dockerenv")) expect(cfg.url).toBe(url);
    fs.rmSync(dir, { recursive: true });
  });

  it("waits for the token file, then gives a clear error", async () => {
    delete process.env.UNO_APP_API_URL;
    delete process.env.UNO_APP_TOKEN;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uno-app-"));
    process.env.UNO_APP_KEY_DIR = dir;
    setTimeout(() => fs.writeFileSync(path.join(dir, "token"), TOKEN), 300);
    expect((await resolveConfig({ waitMs: 3000 })).token).toBe(TOKEN);
    fs.rmSync(path.join(dir, "token"));
    await expect(resolveConfig({ appId: "myapp", waitMs: 200 })).rejects.toThrow(
      'No Uno app token. Add "ai": {"chat": true} and/or "storage": true to ~/.uno/apps/myapp.json',
    );
    fs.rmSync(dir, { recursive: true });
  });
});

describe("parseSSE", () => {
  it("handles a final event without a trailing blank line", async () => {
    const body = new Response('event: done\ndata: {"a":1}').body;
    const out = [];
    for await (const e of parseSSE(body)) out.push(e);
    expect(out).toEqual([{ event: "done", data: '{"a":1}' }]);
  });
});
