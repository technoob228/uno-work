#!/usr/bin/env node
// Fake ACP agent for the T3 v2 contract smoke (v2-contract-smoke.ts).
// No dependencies: newline-delimited JSON-RPC 2.0 over stdio.
//
// Register it with the daemon as a file harness:
//   ~/.uno/harnesses/fake.json  →  {"name":"Fake","command":"/usr/bin/node",
//                                   "args":["<abs path>/v2-fake-acp-agent.mjs"],
//                                   "models":[{"id":"fake-1","name":"Fake 1"}]}
// (or point UNO_WORK_HARNESSES_DIR at another folder). Instance id: harness-fake.
//
// Behaviour by prompt text:
//   contains "approve" → a tool call that asks permission, then "approved" /
//                        "rejected" by the answer;
//   contains "slow"    → streams a chunk per second for ~2 min until cancelled;
//   anything else      → replies "pong: <prompt>".
import { createInterface } from "node:readline";

let nextId = 1_000;
const pending = new Map();
const cancelled = new Set();

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chunk = (sessionId, text) =>
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const raw = (params.prompt ?? [])
    .map((block) => (block && block.type === "text" ? block.text : ""))
    .join(" ");
  // Work prepends its instructions to the first prompt: answer the person's
  // words only (the instructions mention «approve» and friends).
  const text = raw.split("</uno-work-instructions>").pop().trim();
  cancelled.delete(sessionId);

  if (/approve/i.test(text)) {
    const toolCallId = `tool-${Date.now()}`;
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Run `rm -rf build`",
        kind: "execute",
        status: "pending",
        rawInput: { command: "rm -rf build" },
      },
    });
    const answer = await request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "Run `rm -rf build`", kind: "execute", status: "pending" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = answer?.outcome?.outcome === "selected" && answer.outcome.optionId === "allow";
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: allowed ? "completed" : "failed",
      },
    });
    chunk(sessionId, allowed ? "approved" : "rejected");
    return reply(id, { stopReason: "end_turn" });
  }

  if (/slow/i.test(text)) {
    for (let i = 0; i < 120; i += 1) {
      if (cancelled.has(sessionId)) return reply(id, { stopReason: "cancelled" });
      chunk(sessionId, `tick ${i} `);
      await sleep(1_000);
    }
    return reply(id, { stopReason: "end_turn" });
  }

  chunk(sessionId, `pong: ${text}`);
  return reply(id, { stopReason: "end_turn" });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.result);
    return;
  }
  const { id, method, params = {} } = message;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: [],
      });
    case "session/new":
      return reply(id, {
        sessionId: `fake-${Date.now()}`,
        models: {
          currentModelId: "fake-1",
          availableModels: [{ modelId: "fake-1", name: "Fake 1" }],
        },
      });
    case "session/set_model":
    case "session/set_mode":
    case "session/set_config_option":
      return reply(id, {});
    case "session/prompt":
      void prompt(id, params);
      return;
    case "session/cancel":
      cancelled.add(params.sessionId);
      return;
    default:
      if (id !== undefined) {
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
});
