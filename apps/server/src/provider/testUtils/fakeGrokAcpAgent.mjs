#!/usr/bin/env node
// A stand-in for `grok --permission-mode default agent stdio` (Grok CLI 1.0.92
// as checked 23.11.2026) for GrokAdapter.test.ts:
//   - `authenticate cached_token` answers only when $GROK_HOME/auth.json holds
//     a sign-in — without one the real CLI never answers, and neither do we;
//     `xai.api_key` needs XAI_API_KEY; `session/new` before it fails
//     "Authentication required".
//   - `session/new` has no modes; the model is a config option.
//   - `session/load` replays the history marked `_meta.isReplay` and answers,
//     or never answers (FAKE_GROK_LOAD_HANGS=1).
// Each prompt answers with what it saw: the client type from `initialize`,
// the auth method, the model, the argv permission mode. DO_THINK streams a
// thought first; DO_MCP / DO_SHELL ask permission for an uno-work MCP tool /
// a shell command; DO_API_ERROR fails like a refused key; DO_HANG starts a
// tool and waits for `session/cancel`.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const update = (sessionId, update, meta) =>
  send({
    method: "session/update",
    params: { sessionId, update, ...(meta ? { _meta: meta } : {}) },
  });
const waiting = new Map();
let nextId = 1;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const argv = process.argv.slice(2);
const permissionMode = argv[argv.indexOf("--permission-mode") + 1] ?? "none";
let clientType = "generic";
let authMethod;
let model = "grok-4.6";
let cancelTrigger = "none";
let onCancel;

const authFile = path.join(
  process.env.GROK_HOME || path.join(process.env.HOME || "/nonexistent", ".grok"),
  "auth.json",
);
const signedIn = () => existsSync(authFile) && readFileSync(authFile, "utf8").trim().length > 2;

const sessionSetup = (sessionId) => ({
  sessionId,
  models: {
    availableModels: [
      { modelId: "grok-4.6", name: "grok-4.6" },
      { modelId: "grok-4.5", name: "grok-4.5" },
    ],
    currentModelId: model,
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: "grok-4.6", name: "grok-4.6" },
        { value: "grok-4.5", name: "grok-4.5" },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: ["xhigh", "high", "medium", "low"].map((value) => ({ value, name: value })),
    },
  ],
});

async function permission(sessionId, toolCall) {
  update(sessionId, { sessionUpdate: "tool_call", ...toolCall, status: "pending" });
  const { outcome } = await ask("session/request_permission", {
    sessionId,
    toolCall,
    options: [
      { optionId: "cancel", name: "Cancel", kind: "reject_once" },
      { optionId: "allow-edits-session", name: "Allow all edits this session", kind: "allow_always" },
      { optionId: "approve", name: "Approve", kind: "allow_once" },
    ],
  });
  const allowed =
    outcome.outcome === "selected" &&
    (outcome.optionId === "approve" || outcome.optionId === "allow-edits-session");
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: toolCall.toolCallId,
    status: allowed ? "completed" : "failed",
  });
  return allowed;
}

const requireAuth = () => {
  if (!authMethod) {
    throw Object.assign(new Error("auth"), {
      rpc: {
        code: -32000,
        message: "Authentication required",
        data: { message: "no auth method id provided" },
      },
    });
  }
};

const handlers = {
  initialize: (params) => {
    clientType = params?._meta?.clientType ?? "generic";
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      authMethods: [{ id: "grok.com", name: "Sign in with grok.com" }],
    };
  },
  authenticate: ({ methodId }) => {
    if (methodId === "xai.api_key") {
      if (!process.env.XAI_API_KEY) throw new Error("XAI_API_KEY is not set");
      authMethod = methodId;
      return {};
    }
    if (methodId === "cached_token") {
      if (!signedIn()) return new Promise(() => {});
      authMethod = methodId;
      return {};
    }
    throw new Error(`Unknown auth method: ${methodId}`);
  },
  "session/new": () => {
    requireAuth();
    return sessionSetup(`grok-${Date.now()}`);
  },
  "session/load": async ({ sessionId }) => {
    requireAuth();
    update(
      sessionId,
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old reply" } },
      { isReplay: true },
    );
    if (process.env.FAKE_GROK_LOAD_HANGS === "1") return new Promise(() => {});
    return sessionSetup(sessionId);
  },
  "session/set_config_option": ({ configId, value }) => {
    if (configId === "model") model = typeof value === "object" ? value.value : value;
    return sessionSetup("ignored");
  },
  "session/prompt": async ({ sessionId, prompt }) => {
    const text = prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (/\bDO_API_ERROR\b/.test(text)) {
      // What Grok CLI 1.0.92 answers when xAI refuses the key (live 23.11.2026).
      throw Object.assign(new Error("api"), {
        rpc: {
          code: -32603,
          message: "Internal error",
          data: {
            message:
              "API error (status 400 Bad Request): invalid-argument: Incorrect API key provided. You can obtain an API key from https://console.x.ai.",
            http_status: 400,
          },
        },
      });
    }
    if (/\bDO_HANG\b/.test(text)) {
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "long-1",
        title: "run_terminal_command",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "npm run dev" },
      });
      await new Promise((resolve) => {
        onCancel = resolve;
      });
      return { stopReason: "cancelled" };
    }
    if (/\bDO_THINK\b/.test(text)) {
      update(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Weighing the options. " },
      });
    }
    const parts = [];
    if (/\bDO_MCP\b/.test(text)) {
      const allowed = await permission(sessionId, {
        toolCallId: "mcp-1",
        title: "uno-work__notify",
        kind: "other",
      });
      parts.push(allowed ? "mcp allowed" : "mcp denied");
    }
    if (/\bDO_SHELL\b/.test(text)) {
      const allowed = await permission(sessionId, {
        toolCallId: "shell-1",
        title: "ls -la",
        kind: "execute",
      });
      parts.push(allowed ? "shell allowed" : "shell denied");
    }
    parts.push(
      `client=${clientType} auth=${authMethod} model=${model} permission=${permissionMode} cancel=${cancelTrigger}`,
    );
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: parts.join("; ") },
    });
    return { stopReason: "end_turn" };
  },
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined) return waiting.get(msg.id)?.(msg.result ?? {});
  if (msg.method === "session/cancel") {
    cancelTrigger = msg.params?._meta?.cancelTrigger ?? "plain";
    onCancel?.();
    return;
  }
  const handler = handlers[msg.method];
  if (msg.id === undefined) return;
  if (!handler) {
    return send({
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  }
  try {
    send({ id: msg.id, result: await handler(msg.params ?? {}) });
  } catch (error) {
    send({ id: msg.id, error: error.rpc ?? { code: -32603, message: String(error) } });
  }
});
