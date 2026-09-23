/**
 * The App API's HTTP surface (docs/app-sdk.md), as a plain `node:http`
 * request handler over an injected {@link AppApiCore}. It runs on its own
 * listener — loopback and the docker bridge only — never on the daemon's
 * public port, and it knows nothing about Effect, so it is tested with a fake
 * core and a fake gateway.
 */
import type { AppTaskTools } from "@t3tools/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { StoredAppTask } from "./appAiStore.ts";
import type { AppStorage } from "./appStorage.ts";
import type { AppApiReply, AppTaskView } from "./appTasks.ts";
import {
  type ModelPrice,
  chatCostUsd,
  estimateChatCostFromChars,
  makeSseUsageTracker,
  transcriptionCostUsd,
  usageFromPayload,
} from "./pricing.ts";

export const CHAT_BODY_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIO_BODY_MAX_BYTES = 25 * 1024 * 1024;
const TASK_WAIT_MAX_MS = 60_000;
const TASK_POLL_MS = 700;
const SSE_KEEPALIVE_MS = 15_000;
const SSE_MAX_MS = 30 * 60_000;

export interface AppApiCaller {
  readonly appId: string;
  readonly appName: string;
  readonly chat: boolean;
  readonly tasks: boolean;
  readonly limitUsd: number;
  /** Everything counted against the limit: chat + tasks. */
  readonly spentUsd: number;
  /** The part of `spentUsd` the app's tasks spent (gateway, `appTaskMeter.ts`). */
  readonly tasksSpentUsd: number;
  readonly manifestCwd: string | null;
  readonly taskToolsCap: AppTaskTools;
  /**
   * Cloud storage the manifest asks for (`"storage"`); null = none. `folder`
   * is the app's folder in the `apps` bucket — shared (`<id>/`) or this
   * computer's own (`<id>@computer-<box>/`), as the person chose.
   */
  readonly storage: { readonly limitBytes: number; readonly folder: string } | null;
}

export interface AppApiTaskDetail {
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
  }>;
  readonly activities: ReadonlyArray<{
    readonly id: string;
    readonly tone: string;
    readonly kind: string;
    readonly summary: string;
  }>;
}

export interface AppApiCore {
  readonly home: string;
  readonly authenticate: (token: string) => Promise<AppApiCaller | null>;
  /** The machine's AI gateway, or null when this computer has no AI key. */
  readonly gateway: () => Promise<{ readonly baseUrl: string; readonly key: string } | null>;
  readonly defaults: () => Promise<{
    readonly chatModel: string;
    readonly taskHarness: string | null;
  }>;
  readonly prices: () => Promise<ReadonlyMap<string, ModelPrice>>;
  readonly charge: (appId: string, usd: number) => Promise<void>;
  readonly createTask: (
    caller: AppApiCaller,
    body: unknown,
  ) => Promise<{ reply: AppApiReply; task: StoredAppTask | null }>;
  readonly findTask: (appId: string, taskId: string) => StoredAppTask | undefined;
  readonly listTasks: (appId: string) => ReadonlyArray<StoredAppTask>;
  readonly viewTask: (task: StoredAppTask) => Promise<AppTaskView>;
  readonly taskDetail: (task: StoredAppTask) => Promise<AppApiTaskDetail | null>;
  readonly stopTask: (caller: AppApiCaller, task: StoredAppTask) => Promise<boolean>;
  /** The app's folder in the account's cloud; absent when the daemon has none. */
  readonly storage?: AppStorage;
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, reply: AppApiReply): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(reply.body);
  res.writeHead(reply.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

const err = (status: number, code: string, message: string): AppApiReply => ({
  status,
  body: { error: { type: code, code, message } },
});

export const LIMIT_REACHED_MESSAGE =
  "This app used its AI limit. The person who owns this computer can raise it in Uno Work → Settings → Apps.";

function bearer(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function remaining(caller: AppApiCaller) {
  return Math.max(0, caller.limitUsd - caller.spentUsd);
}

function sseHeaders(res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

export function makeAppApiHandler(core: AppApiCore) {
  const requireAi = (caller: AppApiCaller, what: "chat" | "tasks"): AppApiReply | null => {
    if (!caller[what]) {
      return err(
        403,
        "ai_not_allowed",
        what === "chat"
          ? 'This app\'s manifest does not ask for AI chat. Add "ai": {"chat": true} to ~/.uno/apps/<id>.json.'
          : 'This app\'s manifest does not ask for AI tasks. Add "ai": {"tasks": true} to ~/.uno/apps/<id>.json.',
      );
    }
    if (remaining(caller) <= 0) return err(402, "app_limit_reached", LIMIT_REACHED_MESSAGE);
    return null;
  };

  const whoami = async (caller: AppApiCaller): Promise<AppApiReply> => {
    const defaults = await core.defaults();
    return {
      status: 200,
      body: {
        app: { id: caller.appId, name: caller.appName },
        ai: {
          chat: caller.chat,
          tasks: caller.tasks,
          limitUsd: caller.limitUsd,
          spentUsd: Math.round(caller.spentUsd * 1e6) / 1e6,
          chatSpentUsd: Math.round((caller.spentUsd - caller.tasksSpentUsd) * 1e6) / 1e6,
          tasksSpentUsd: Math.round(caller.tasksSpentUsd * 1e6) / 1e6,
          remainingUsd: Math.round(remaining(caller) * 1e6) / 1e6,
          taskToolsCap: caller.taskToolsCap,
        },
        storage: caller.storage
          ? {
              enabled: true,
              limitBytes: caller.storage.limitBytes,
              usedBytes: core.storage?.cachedUsage(caller.storage.folder)?.usedBytes ?? null,
            }
          : { enabled: false },
        defaults,
        home: core.home,
      },
    };
  };

  const models = async (caller: AppApiCaller, res: ServerResponse) => {
    const denied = requireAi(caller, "chat");
    if (denied && denied.status === 403) return send(res, denied);
    const gateway = await core.gateway();
    if (!gateway) return send(res, notConnected());
    const upstream = await fetch(`${gateway.baseUrl}/models`, {
      headers: { authorization: `Bearer ${gateway.key}` },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!upstream)
      return send(res, err(502, "gateway_unreachable", "The Uno AI gateway did not answer."));
    res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  };

  const notConnected = () =>
    err(
      503,
      "ai_not_connected",
      "This computer has no Uno AI connected yet. Sign in to Uno in Uno Work to turn it on.",
    );

  const chatCompletions = async (
    caller: AppApiCaller,
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const denied = requireAi(caller, "chat");
    if (denied) return send(res, denied);
    const raw = await readBody(req, CHAT_BODY_MAX_BYTES);
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      return send(
        res,
        err(400, "invalid_request", "Expected an OpenAI chat completions JSON body."),
      );
    }
    if (!Array.isArray(body["messages"]) || body["messages"].length === 0) {
      return send(res, err(400, "invalid_request", '"messages" must be a non-empty array.'));
    }
    const gateway = await core.gateway();
    if (!gateway) return send(res, notConnected());
    const defaults = await core.defaults();
    const model =
      typeof body["model"] === "string" &&
      body["model"].trim() !== "" &&
      body["model"] !== "default"
        ? body["model"].trim()
        : defaults.chatModel;
    const streaming = body["stream"] === true;
    const outgoing: Record<string, unknown> = { ...body, model };
    if (streaming) {
      const options =
        typeof body["stream_options"] === "object" && body["stream_options"] !== null
          ? (body["stream_options"] as Record<string, unknown>)
          : {};
      outgoing["stream_options"] = { ...options, include_usage: true };
    }
    const promptChars = JSON.stringify(body["messages"]).length;

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const upstream = await fetch(`${gateway.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.key}`,
        "content-type": "application/json",
        "user-agent": `UnoWork-AppSDK/${caller.appId}`,
      },
      body: JSON.stringify(outgoing),
      signal: abort.signal,
    }).catch(() => null);
    if (!upstream)
      return send(res, err(502, "gateway_unreachable", "The Uno AI gateway did not answer."));
    const prices = await core.prices().catch(() => new Map<string, ModelPrice>());
    const price = prices.get(model);

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(text);
      return;
    }

    if (!streaming) {
      const text = await upstream.text();
      let cost = 0;
      try {
        const usage = usageFromPayload(JSON.parse(text));
        cost = usage
          ? chatCostUsd(usage, price)
          : estimateChatCostFromChars(promptChars, text.length, price);
      } catch {
        cost = estimateChatCostFromChars(promptChars, text.length, price);
      }
      await core.charge(caller.appId, cost);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(text);
      return;
    }

    sseHeaders(res);
    const tracker = makeSseUsageTracker();
    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        tracker.push(decoder.decode(chunk, { stream: true }));
        res.write(chunk);
      }
    } catch {
      // Client went away or the gateway dropped: settle what was streamed.
    } finally {
      const { usage, contentChars } = tracker.finish();
      const cost = usage
        ? chatCostUsd(usage, price)
        : estimateChatCostFromChars(promptChars, contentChars, price);
      await core.charge(caller.appId, cost);
      res.end();
    }
  };

  const transcriptions = async (
    caller: AppApiCaller,
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const denied = requireAi(caller, "chat");
    if (denied) return send(res, denied);
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.startsWith("multipart/form-data")) {
      return send(
        res,
        err(400, "invalid_request", "Send the audio as multipart/form-data like OpenAI."),
      );
    }
    const raw = await readBody(req, AUDIO_BODY_MAX_BYTES);
    const gateway = await core.gateway();
    if (!gateway) return send(res, notConnected());
    const upstream = await fetch(`${gateway.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gateway.key}`,
        "content-type": contentType,
        "user-agent": `UnoWork-AppSDK/${caller.appId}`,
      },
      body: raw,
      signal: AbortSignal.timeout(10 * 60_000),
    }).catch(() => null);
    if (!upstream)
      return send(res, err(502, "gateway_unreachable", "The Uno AI gateway did not answer."));
    const text = await upstream.text();
    if (upstream.ok) {
      let duration: number | null = null;
      try {
        const parsed = JSON.parse(text) as { duration?: unknown };
        duration = typeof parsed.duration === "number" ? parsed.duration : null;
      } catch {
        // response_format=text
      }
      await core.charge(
        caller.appId,
        transcriptionCostUsd({ audioBytes: raw.length, durationSeconds: duration }),
      );
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(text);
  };

  const createTask = async (caller: AppApiCaller, req: IncomingMessage, res: ServerResponse) => {
    const denied = requireAi(caller, "tasks");
    if (denied) return send(res, denied);
    const raw = await readBody(req, 256 * 1024);
    let body: unknown = null;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      body = null;
    }
    const { reply } = await core.createTask(caller, body);
    send(res, reply);
  };

  const getTask = async (caller: AppApiCaller, taskId: string, url: URL, res: ServerResponse) => {
    const task = core.findTask(caller.appId, taskId);
    if (!task) return send(res, err(404, "task_not_found", "No such task of this app."));
    const waitMs = Math.min(
      TASK_WAIT_MAX_MS,
      Math.max(0, Number(url.searchParams.get("waitMs")) || 0),
    );
    const deadline = Date.now() + waitMs;
    let view = await core.viewTask(task);
    // Flipped by the "close" listener; an object so the loop re-reads it.
    const client = { closed: false };
    res.on("close", () => {
      client.closed = true;
    });
    while (view.status === "running" && Date.now() < deadline && !client.closed) {
      await new Promise((resolve) => setTimeout(resolve, TASK_POLL_MS));
      view = await core.viewTask(task);
    }
    send(res, { status: 200, body: view });
  };

  const taskEvents = async (caller: AppApiCaller, taskId: string, res: ServerResponse) => {
    const task = core.findTask(caller.appId, taskId);
    if (!task) return send(res, err(404, "task_not_found", "No such task of this app."));
    sseHeaders(res);
    // Flipped by the "close" listener; an object so the loop re-reads it.
    const client = { closed: false };
    res.on("close", () => {
      client.closed = true;
    });
    const event = (name: string, data: unknown) => {
      if (!client.closed) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const emitted = new Map<string, number>();
    const seenActivities = new Set<string>();
    let lastStatus: string | null = null;
    let lastKeepAlive = Date.now();
    const started = Date.now();
    while (!client.closed && Date.now() - started < SSE_MAX_MS) {
      const [view, detail] = await Promise.all([core.viewTask(task), core.taskDetail(task)]);
      if (view.status !== lastStatus) {
        lastStatus = view.status;
        event("status", { status: view.status, waitingFor: view.waitingFor });
      }
      if (detail) {
        for (const activity of detail.activities) {
          if (seenActivities.has(activity.id)) continue;
          seenActivities.add(activity.id);
          event("activity", {
            kind: activity.kind,
            tone: activity.tone,
            summary: activity.summary,
          });
        }
        for (const message of detail.messages) {
          if (message.role !== "assistant") continue;
          const sent = emitted.get(message.id) ?? 0;
          if (message.text.length > sent) {
            event("message", { id: message.id, delta: message.text.slice(sent) });
            emitted.set(message.id, message.text.length);
          }
        }
      }
      if (view.status === "done" || view.status === "error" || view.status === "stopped") {
        event("done", view);
        break;
      }
      if (Date.now() - lastKeepAlive > SSE_KEEPALIVE_MS) {
        if (!client.closed) res.write(": keep-alive\n\n");
        lastKeepAlive = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, TASK_POLL_MS));
    }
    res.end();
  };

  const stopTask = async (caller: AppApiCaller, taskId: string, res: ServerResponse) => {
    const task = core.findTask(caller.appId, taskId);
    if (!task) return send(res, err(404, "task_not_found", "No such task of this app."));
    const stopped = await core.stopTask(caller, task);
    send(res, {
      status: stopped ? 200 : 409,
      body: { ok: stopped, task: await core.viewTask(task) },
    });
  };

  const listTasks = async (caller: AppApiCaller, res: ServerResponse) => {
    const tasks = await Promise.all(core.listTasks(caller.appId).slice(0, 20).map(core.viewTask));
    send(res, { status: 200, body: { tasks } });
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://app-api.local");
      const route = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";
      if (method === "GET" && (route === "/health" || route === "/")) {
        return send(res, {
          status: 200,
          body: { ok: true, service: "uno-app-api", docs: "https://uno4.dev/llms.txt" },
        });
      }
      const token = bearer(req);
      const caller = token ? await core.authenticate(token) : null;
      if (!caller) {
        return send(
          res,
          err(
            401,
            "invalid_app_token",
            'Missing or unknown app token. An app gets one when its manifest ~/.uno/apps/<id>.json has an "ai" or "storage" block.',
          ),
        );
      }
      if (method === "GET" && route === "/v1/whoami") return send(res, await whoami(caller));
      if (method === "GET" && route === "/v1/models") return await models(caller, res);
      if (method === "POST" && route === "/v1/chat/completions") {
        return await chatCompletions(caller, req, res);
      }
      if (method === "POST" && route === "/v1/audio/transcriptions") {
        return await transcriptions(caller, req, res);
      }
      if (route === "/v1/tasks") {
        if (method === "POST") return await createTask(caller, req, res);
        if (method === "GET") return await listTasks(caller, res);
      }
      const taskMatch = /^\/v1\/tasks\/([A-Za-z0-9_-]{1,80})(\/events|\/stop)?$/.exec(route);
      if (taskMatch) {
        const [, taskId = "", tail] = taskMatch;
        if (method === "GET" && tail === undefined) return await getTask(caller, taskId, url, res);
        if (method === "GET" && tail === "/events") return await taskEvents(caller, taskId, res);
        if (method === "POST" && tail === "/stop") return await stopTask(caller, taskId, res);
      }
      if (route === "/v1/storage" || route.startsWith("/v1/storage/")) {
        if (!caller.storage) {
          return send(
            res,
            err(
              403,
              "storage_not_allowed",
              'This app\'s manifest does not ask for cloud storage. Add "storage": {"limitGb": 5} to ~/.uno/apps/<id>.json.',
            ),
          );
        }
        if (!core.storage) {
          return send(
            res,
            err(503, "storage_unavailable", "Cloud storage isn't available on this computer."),
          );
        }
        const reply = await core.storage.handle(
          {
            folder: caller.storage.folder,
            limitBytes: caller.storage.limitBytes,
            method,
            route,
            url,
          },
          req,
          res,
        );
        if (reply) send(res, reply);
        return;
      }
      send(res, err(404, "not_found", `No ${method} ${route} in the Uno App API.`));
    } catch (cause) {
      if (cause instanceof BodyTooLarge) {
        return send(res, err(413, "request_too_large", "The request body is too large."));
      }
      send(res, err(500, "internal_error", "The App API failed on this request."));
    }
  };
}
