#!/usr/bin/env node
// Minimal ACP agent for Uno Work (docs/custom-harness.md). No dependencies.
// Echoes each prompt. "plan" in a prompt → a plan update; "write" → asks
// permission first (Approve/Deny in Uno Work), then reports a file edit.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const update = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const waiting = new Map(); // our request id → resolve
let nextId = 1;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
    agentInfo: { name: "acp-echo", version: "1.0.0" },
    authMethods: [],
  }),
  "session/new": () => ({ sessionId: `echo-${Date.now()}` }),
  "session/prompt": async ({ sessionId, prompt }) => {
    const text = prompt
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (/plan/i.test(text)) {
      update(sessionId, {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the request", priority: "high", status: "completed" },
          { content: "Echo it back", priority: "medium", status: "in_progress" },
        ],
      });
    }
    if (/write/i.test(text)) {
      const toolCall = {
        toolCallId: "write-1",
        title: "Write notes.txt",
        kind: "edit",
        status: "pending",
      };
      update(sessionId, { sessionUpdate: "tool_call", ...toolCall });
      const { outcome } = await ask("session/request_permission", {
        sessionId,
        toolCall,
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      const allowed = outcome.outcome === "selected" && outcome.optionId === "yes";
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "write-1",
        status: allowed ? "completed" : "failed",
      });
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: allowed ? "Permission granted. " : "Permission denied. " },
      });
    }
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Echo: ${text}` },
    });
    return { stopReason: "end_turn" };
  },
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined) return waiting.get(msg.id)?.(msg.result ?? {}); // a reply to ask()
  const handler = handlers[msg.method];
  if (msg.id === undefined) return; // notifications (session/cancel) — nothing to cancel here
  if (!handler)
    return send({
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  try {
    send({ id: msg.id, result: await handler(msg.params ?? {}) });
  } catch (error) {
    send({ id: msg.id, error: { code: -32603, message: String(error) } });
  }
});
