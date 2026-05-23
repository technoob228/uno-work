#!/usr/bin/env node
// Stdio MCP bridge for Uno web search.
//
// Spoken protocol: JSON-RPC 2.0 over stdio, line-delimited (one JSON
// message per line, terminated by `\n`). This matches the MCP transport
// implemented by uno-code/sst-opencode.
//
// Tool exposed: `web_search(query, count?, country?, freshness?)` →
// proxies to POST {UNO_GATEWAY_BASE_URL}/search using the user's
// Uno Bearer token. The Brave API key stays on the Gateway; billing
// runs through `users.llm_balance` server-side.
//
// Env contract (set by UnoDriver via OPENCODE_CONFIG_CONTENT.mcp):
//   UNO_API_KEY            — user's Uno gateway token (required)
//   UNO_GATEWAY_BASE_URL   — e.g. "https://api.getuno.xyz/v1" (required)

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "uno-search";
const SERVER_VERSION = "0.1.0";

const apiKey = process.env.UNO_API_KEY ?? "";
const baseUrl = (process.env.UNO_GATEWAY_BASE_URL ?? "").replace(/\/+$/, "");

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message, data) {
  write({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

const TOOLS = [
  {
    name: "web_search",
    description:
      "Search the web via Uno's billed proxy (Brave-powered). Returns a list of result snippets. Each call is billed against the user's Uno LLM balance.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (1..400 chars).",
          minLength: 1,
          maxLength: 400,
        },
        count: {
          type: "integer",
          description: "Max results (1..20). Default 5.",
          minimum: 1,
          maximum: 20,
          default: 5,
        },
        country: {
          type: "string",
          description: "Brave country code, e.g. 'US', 'RU'. Optional.",
        },
        freshness: {
          type: "string",
          description: "'pd' (day), 'pw' (week), 'pm' (month), 'py' (year). Optional.",
          enum: ["pd", "pw", "pm", "py"],
        },
      },
      required: ["query"],
    },
  },
];

async function callWebSearch(args) {
  if (apiKey.length === 0) {
    throw new Error(
      "UNO_API_KEY is not set. Connect your Uno account in Uno Work → Settings.",
    );
  }
  if (baseUrl.length === 0) {
    throw new Error("UNO_GATEWAY_BASE_URL is not set.");
  }
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (query.length === 0) throw new Error("Missing required argument: query");

  const body = { query, count: Math.min(Math.max(Number(args?.count ?? 5) | 0, 1), 20) };
  if (typeof args?.country === "string" && args.country) body.country = args.country;
  if (typeof args?.freshness === "string" && args.freshness) body.freshness = args.freshness;

  const response = await fetch(`${baseUrl}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* keep parsed = null; surface raw text below */
  }

  if (!response.ok) {
    if (response.status === 402) {
      throw new Error(
        "Uno LLM balance is empty. Top it up via the Uno dashboard to keep using web search.",
      );
    }
    if (response.status === 429) {
      throw new Error("Uno web search rate limit reached. Try again in a minute.");
    }
    const detail = parsed?.error ?? parsed?.message ?? raw ?? `HTTP ${response.status}`;
    throw new Error(`Uno search failed (${response.status}): ${detail}`);
  }

  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const lines = results.map((entry, idx) => {
    const title = entry?.title ?? "(no title)";
    const url = entry?.url ?? "";
    const desc = entry?.description ?? "";
    const age = entry?.age ? ` · ${entry.age}` : "";
    return `${idx + 1}. ${title}${age}\n   ${url}\n   ${desc}`;
  });
  const header = `Results for "${parsed?.query ?? query}" (${results.length}):\n`;
  return header + (lines.length > 0 ? lines.join("\n\n") : "(no results)");
}

const HANDLERS = {
  initialize(_params) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  },
  "tools/list"() {
    return { tools: TOOLS };
  },
  async "tools/call"(params) {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name !== "web_search") {
      const error = `Unknown tool: ${name}`;
      return { isError: true, content: [{ type: "text", text: error }] };
    }
    try {
      const text = await callWebSearch(args);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text }] };
    }
  },
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length > 0) void handleLine(line);
    newlineIndex = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, "Parse error");
    return;
  }
  const { id, method, params } = message;
  // Notifications (no id) have no response — including "notifications/initialized".
  const isNotification = id === undefined || id === null;
  const handler = HANDLERS[method];
  if (!handler) {
    if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
    return;
  }
  try {
    const result = await handler(params);
    if (!isNotification) ok(id, result);
  } catch (err) {
    if (!isNotification) {
      const detail = err instanceof Error ? err.message : String(err);
      fail(id, -32603, detail);
    }
  }
}
