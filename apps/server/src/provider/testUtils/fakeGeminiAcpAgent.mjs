#!/usr/bin/env node
// A stand-in for `gemini --acp` (Gemini CLI 0.70.0 as checked 20.11.2026) for
// GeminiAdapter.test.ts: the same modes and models in `session/new`, the
// session starting in the mode settings.json would give (FAKE_GEMINI_START_MODE,
// e.g. a person's own "yolo"), MCP tool titles "<tool> (<server> MCP Server)".
// Each prompt answers with the mode it ran in; DO_MCP / DO_SHELL in a prompt ask
// permission for an uno-work MCP tool / a shell command first.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const update = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const waiting = new Map();
let nextId = 1;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const MODES = ["default", "autoEdit", "yolo", "plan"];
let mode = process.env.FAKE_GEMINI_START_MODE || "default";
let model = "auto";
const modeLog = [];

async function permission(sessionId, toolCall) {
  update(sessionId, { sessionUpdate: "tool_call", ...toolCall, status: "pending" });
  const { outcome } = await ask("session/request_permission", {
    sessionId,
    toolCall,
    options: [
      { optionId: "proceed_once", name: "Allow", kind: "allow_once" },
      { optionId: "proceed_always", name: "Allow always", kind: "allow_always" },
      { optionId: "cancel", name: "Reject", kind: "reject_once" },
    ],
  });
  const allowed = outcome.outcome === "selected" && outcome.optionId.startsWith("proceed");
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: toolCall.toolCallId,
    status: allowed ? "completed" : "failed",
  });
  return allowed;
}

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
    },
    authMethods: [
      { id: "oauth-personal", name: "Log in with Google" },
      { id: "gemini-api-key", name: "Use Gemini API key" },
    ],
  }),
  "session/new": () => ({
    sessionId: `gemini-${Date.now()}`,
    modes: {
      availableModes: MODES.map((id) => ({ id, name: id })),
      currentModeId: mode,
    },
    models: {
      availableModels: [
        { modelId: "auto", name: "Auto" },
        { modelId: "gemini-3-flash-preview", name: "gemini-3-flash-preview" },
      ],
      currentModelId: model,
    },
  }),
  "session/set_mode": ({ modeId }) => {
    if (!MODES.includes(modeId)) throw new Error(`Invalid mode: ${modeId}`);
    mode = modeId;
    modeLog.push(modeId);
    return {};
  },
  "session/set_model": ({ modelId }) => {
    model = modelId;
    return {};
  },
  "session/prompt": async ({ sessionId, prompt }) => {
    const text = prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const parts = [];
    if (/\bDO_MCP\b/.test(text)) {
      const allowed = await permission(sessionId, {
        toolCallId: "mcp-1",
        title: "notify (uno-work MCP Server)",
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
    parts.push(`mode=${mode} model=${model} set_mode=${modeLog.join(",") || "none"}`);
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
    send({ id: msg.id, error: { code: -32603, message: String(error) } });
  }
});
