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
import {
  type AppAiRoute,
  type AppAiRouteResult,
  NOT_CONNECTED_MESSAGE,
  probeOpenAiEndpoint,
} from "./appAiProviders.ts";
import { type ParsedNotify, makeNotifyLimiter, parseNotifyBody } from "./appNotify.ts";
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
  /** The manifest asks to tell the person things (`"notify": true`). */
  readonly notify?: boolean;
  /** The manifest's icon (emoji / letters), shown next to its notifications. */
  readonly appIcon?: string | null;
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
  /**
   * Where this app's answers go now (Settings → Apps). Absent (older tests,
   * embedders): always the Uno gateway, metered.
   */
  readonly route?: (caller: AppApiCaller) => Promise<AppAiRouteResult>;
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
  /** Put a notification into the person's Inbox; absent when there's no Inbox. */
  readonly notify?: (
    caller: AppApiCaller,
    notification: ParsedNotify,
  ) => Promise<{ readonly id: string }>;
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

function upstreamHeaders(route: AppAiRoute, caller: AppApiCaller, contentType?: string) {
  return {
    ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}),
    ...(contentType ? { "content-type": contentType } : {}),
    "user-agent": `UnoWork-AppSDK/${caller.appId}`,
    ...route.headers,
  };
}

export function makeAppApiHandler(core: AppApiCore) {
  const requireAi = (
    caller: AppApiCaller,
    what: "chat" | "tasks",
    metered = true,
  ): AppApiReply | null => {
    if (!caller[what]) {
      return err(
        403,
        "ai_not_allowed",
        what === "chat"
          ? 'This app\'s manifest does not ask for AI chat. Add "ai": {"chat": true} to ~/.uno/apps/<id>.json.'
          : 'This app\'s manifest does not ask for AI tasks. Add "ai": {"tasks": true} to ~/.uno/apps/<id>.json.',
      );
    }
    if (metered && remaining(caller) <= 0) {
      return err(402, "app_limit_reached", LIMIT_REACHED_MESSAGE);
    }
    return null;
  };

  const gatewayRoute = async (): Promise<AppAiRouteResult> => {
    const gateway = await core.gateway();
    if (!gateway) {
      return { ok: false, status: 503, code: "ai_not_connected", message: NOT_CONNECTED_MESSAGE };
    }
    const defaults = await core.defaults();
    return {
      ok: true,
      route: {
        kind: "uno",
        baseUrl: gateway.baseUrl,
        apiKey: gateway.key,
        headers: {},
        metered: true,
        defaultModel: defaults.chatModel,
        label: "Uno AI",
      },
    };
  };
  const routeOf = (caller: AppApiCaller) => (core.route ? core.route(caller) : gatewayRoute());
  const routeError = (result: Extract<AppAiRouteResult, { ok: false }>) =>
    err(result.status, result.code, result.message);
  const unreachable = (route: AppAiRoute) =>
    err(
      502,
      route.kind === "uno" ? "gateway_unreachable" : "provider_unreachable",
      route.kind === "uno"
        ? "The Uno AI gateway did not answer."
        : `${route.label} did not answer. Is it running? The person can pick another provider in Uno Work → Settings → Apps.`,
    );
  /**
   * An error of the upstream, passed on. A provider holding the person's key
   * gets its body replaced: some echo (part of) the key back.
   */
  const passError = async (route: AppAiRoute, upstream: Response, res: ServerResponse) => {
    const text = await upstream.text().catch(() => "");
    if (route.kind === "byok") {
      return send(
        res,
        err(
          upstream.status,
          "provider_error",
          `${route.label} answered ${upstream.status}${upstream.status === 401 || upstream.status === 403 ? " — the key was refused" : ""}.`,
        ),
      );
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(text);
  };

  const whoami = async (caller: AppApiCaller): Promise<AppApiReply> => {
    const defaults = await core.defaults();
    const routed = await routeOf(caller);
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
        provider: routed.ok
          ? {
              kind: routed.route.kind,
              label: routed.route.label,
              model: routed.route.defaultModel,
              metered: routed.route.metered,
            }
          : { kind: null, label: null, model: null, metered: false, error: routed.message },
        defaults: {
          ...defaults,
          chatModel: routed.ok
            ? (routed.route.defaultModel ?? defaults.chatModel)
            : defaults.chatModel,
        },
        home: core.home,
      },
    };
  };

  const models = async (caller: AppApiCaller, res: ServerResponse) => {
    const denied = requireAi(caller, "chat");
    if (denied && denied.status === 403) return send(res, denied);
    const routed = await routeOf(caller);
    if (!routed.ok) return send(res, routeError(routed));
    const route = routed.route;
    const upstream = await fetch(`${route.baseUrl}/models`, {
      headers: upstreamHeaders(route, caller),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!upstream) return send(res, unreachable(route));
    if (!upstream.ok) return passError(route, upstream, res);
    res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  };

  const notConnected = () => err(503, "ai_not_connected", NOT_CONNECTED_MESSAGE);

  const chatCompletions = async (
    caller: AppApiCaller,
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const permission = requireAi(caller, "chat", false);
    if (permission) return send(res, permission);
    const routed = await routeOf(caller);
    if (!routed.ok) return send(res, routeError(routed));
    const route = routed.route;
    // The limit is Uno AI's: a local server or the person's own key isn't capped here.
    const denied = requireAi(caller, "chat", route.metered);
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
    let model =
      typeof body["model"] === "string" &&
      body["model"].trim() !== "" &&
      body["model"] !== "default"
        ? body["model"].trim()
        : route.defaultModel;
    if (model === null) {
      // A local server / own key without a chosen model: its first one.
      const listed = await probeOpenAiEndpoint(route.baseUrl, {
        timeoutMs: 5_000,
        ...(route.apiKey ? { apiKey: route.apiKey } : {}),
      });
      if (!listed) return send(res, unreachable(route));
      model = listed.ids[0] ?? null;
      if (model === null) {
        return send(
          res,
          err(
            503,
            "no_model",
            `${route.label} has no model loaded. Load one (e.g. \`ollama pull qwen3:4b\`) or pick a model in Uno Work → Settings → Apps.`,
          ),
        );
      }
    }
    const streaming = body["stream"] === true;
    const outgoing: Record<string, unknown> = { ...body, model };
    if (streaming && route.metered) {
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
    const upstream = await fetch(`${route.baseUrl}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(route, caller, "application/json"),
      body: JSON.stringify(outgoing),
      signal: abort.signal,
    }).catch(() => null);
    if (!upstream) return send(res, unreachable(route));
    const prices = route.metered
      ? await core.prices().catch(() => new Map<string, ModelPrice>())
      : new Map<string, ModelPrice>();
    const price = prices.get(model);
    // Only Uno AI is charged against the app's limit; other providers count a use.
    const settle = (usd: number) => core.charge(caller.appId, route.metered ? usd : 0);

    if (!upstream.ok || !upstream.body) return passError(route, upstream, res);

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
      await settle(cost);
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
      await settle(cost);
      res.end();
    }
  };

  const transcriptions = async (
    caller: AppApiCaller,
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const permission = requireAi(caller, "chat", false);
    if (permission) return send(res, permission);
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.startsWith("multipart/form-data")) {
      return send(
        res,
        err(400, "invalid_request", "Send the audio as multipart/form-data like OpenAI."),
      );
    }
    const raw = await readBody(req, AUDIO_BODY_MAX_BYTES);
    // Speech-to-text follows the person's own key; a local server or the GPU
    // rarely has it, so those stay on Uno AI (metered).
    const chosen = await routeOf(caller);
    let route: AppAiRoute;
    if (chosen.ok && chosen.route.kind === "byok") {
      route = chosen.route;
    } else {
      const gateway = await gatewayRoute();
      if (!gateway.ok) return send(res, notConnected());
      route = gateway.route;
    }
    const denied = requireAi(caller, "chat", route.metered);
    if (denied) return send(res, denied);
    const upstream = await fetch(`${route.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: upstreamHeaders(route, caller, contentType),
      body: raw,
      signal: AbortSignal.timeout(10 * 60_000),
    }).catch(() => null);
    if (!upstream) return send(res, unreachable(route));
    if (!upstream.ok && route.kind === "byok") return passError(route, upstream, res);
    const text = await upstream.text();
    if (upstream.ok && route.metered) {
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

  const notifyLimiter = makeNotifyLimiter();
  const notify = async (caller: AppApiCaller, req: IncomingMessage, res: ServerResponse) => {
    if (!caller.notify) {
      return send(
        res,
        err(
          403,
          "notify_not_allowed",
          'This app\'s manifest does not ask to notify the person. Add "notify": true to ~/.uno/apps/<id>.json.',
        ),
      );
    }
    if (!core.notify) {
      return send(res, err(503, "notify_unavailable", "Notifications aren't available here."));
    }
    const raw = await readBody(req, 16 * 1024);
    let body: unknown = null;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      body = null;
    }
    const parsed = parseNotifyBody(body, { appId: caller.appId, home: core.home });
    if (!parsed.ok) return send(res, err(400, "invalid_request", parsed.message));
    const wait = notifyLimiter.take(caller.appId);
    if (wait !== null) {
      res.setHeader("retry-after", String(wait));
      return send(res, {
        status: 429,
        body: {
          error: {
            type: "notify_rate_limited",
            code: "notify_rate_limited",
            message: `Too many notifications from this app. Try again in ${wait} s.`,
          },
          retryAfterSeconds: wait,
        },
      });
    }
    const posted = await core.notify(caller, parsed.value);
    send(res, { status: 201, body: { ok: true, id: posted.id } });
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
            'Missing or unknown app token. An app gets one when its manifest ~/.uno/apps/<id>.json has an "ai", "storage" or "notify" block.',
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
      if (method === "POST" && route === "/v1/notify") return await notify(caller, req, res);
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
