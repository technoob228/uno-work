/**
 * "Does this MCP server work?" — the check behind Setup's "Add a tool by URL"
 * (`POST /api/manager/mcp/probe`). Runs on the daemon, so it sees the server
 * exactly as the agents on this computer will.
 *
 * Streamable HTTP, the client half: `initialize` (2025-06-18, falling back to
 * 2025-03-26) → `notifications/initialized` → `tools/list` following
 * `nextCursor`. Answers may be `application/json` or a `text/event-stream`;
 * the `Mcp-Session-Id` the server hands out is sent back on every request and
 * the session is closed (DELETE) at the end. A 401/403 or a
 * `WWW-Authenticate` header means the server wants a sign-in: that's a
 * result (`needsAuth`), not a failure.
 *
 * @module setupTools/mcpProbe
 */
import {
  guardedFetch,
  NetGuardError,
  parsePublicHttpUrl,
  readLimited,
  type HostLookup,
} from "./netGuard.ts";

export const MCP_PROBE_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const MCP_PROBE_MAX_TOOLS = 500;
export const MCP_PROBE_TOOL_NAMES_SHOWN = 50;
const MAX_PAGES = 50;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface McpProbeResult {
  readonly ok: boolean;
  readonly toolCount: number;
  readonly toolNames: ReadonlyArray<string>;
  readonly needsAuth: boolean;
  readonly error: string | null;
}

export interface McpProbeOptions {
  readonly fetch?: typeof fetch;
  readonly lookup?: HostLookup;
  /** Per request. */
  readonly timeoutMs?: number;
}

class NeedsAuth extends Error {}

class ProbeFailure extends Error {}

const failed = (error: string): McpProbeResult => ({
  ok: false,
  toolCount: 0,
  toolNames: [],
  needsAuth: false,
  error,
});

interface JsonRpcReply {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** The JSON-RPC response with `id` out of an SSE body (read as it arrives). */
async function readSseReply(response: Response, id: number): Promise<JsonRpcReply | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  const takeEvent = (block: string): JsonRpcReply | null => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.length === 0) return null;
    try {
      const parsed = JSON.parse(data) as unknown;
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of messages) {
        if (
          message !== null &&
          typeof message === "object" &&
          (message as { id?: unknown }).id === id
        ) {
          return message as JsonRpcReply;
        }
      }
    } catch {
      // not JSON: a comment or keep-alive
    }
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new ProbeFailure("The server's answer is too large.");
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += "\n\n";
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const reply = takeEvent(block);
        if (reply) return reply;
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) return null;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function describeFetchError(cause: unknown): string {
  if (cause instanceof NetGuardError || cause instanceof ProbeFailure) return cause.message;
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return "The server didn't answer within 10 seconds.";
  }
  const code = (cause as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Couldn't find that server.";
  if (code === "ECONNREFUSED") return "The server refused the connection.";
  if (typeof code === "string" && code.startsWith("CERT_")) {
    return "The server's HTTPS certificate isn't valid.";
  }
  return "Couldn't reach the server.";
}

export async function probeMcpServer(
  rawUrl: string,
  options: McpProbeOptions = {},
): Promise<McpProbeResult> {
  let url: URL;
  try {
    url = parsePublicHttpUrl(rawUrl);
  } catch (cause) {
    return failed(cause instanceof Error ? cause.message : "That isn't a web address.");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 1;

  const send = async (
    body: Record<string, unknown>,
    expectReply: boolean,
  ): Promise<JsonRpcReply | null> => {
    const id = expectReply ? nextId++ : undefined;
    const response = await guardedFetch(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      },
      {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.lookup ? { lookup: options.lookup } : {}),
      },
    );
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new NeedsAuth();
    }
    if (response.headers.get("www-authenticate") && !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new NeedsAuth();
    }
    const session = response.headers.get("mcp-session-id");
    if (session) sessionId = session;
    if (id === undefined) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProbeFailure(`The server answered HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const reply = await readSseReply(response, id);
      if (!reply) throw new ProbeFailure("The server's event stream ended without an answer.");
      return reply;
    }
    const { bytes, truncated } = await readLimited(response, MAX_RESPONSE_BYTES);
    if (truncated) throw new ProbeFailure("The server's answer is too large.");
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const reply = messages.find(
        (message) =>
          message !== null &&
          typeof message === "object" &&
          (message as { id?: unknown }).id === id,
      );
      if (!reply) throw new ProbeFailure("The server's answer isn't an MCP response.");
      return reply as JsonRpcReply;
    } catch (cause) {
      if (cause instanceof ProbeFailure) throw cause;
      throw new ProbeFailure("The server's answer isn't an MCP response (not JSON).");
    }
  };

  try {
    // initialize, newest protocol first.
    let initialized: JsonRpcReply | null = null;
    let lastProblem = "The server didn't accept the MCP handshake.";
    for (const version of MCP_PROBE_PROTOCOL_VERSIONS) {
      try {
        const reply = await send(
          {
            method: "initialize",
            params: {
              protocolVersion: version,
              capabilities: {},
              clientInfo: { name: "uno-work-probe", version: "1.0.0" },
            },
          },
          true,
        );
        if (reply?.result && typeof reply.result === "object") {
          initialized = reply;
          const agreed = (reply.result as { protocolVersion?: unknown }).protocolVersion;
          protocolVersion = typeof agreed === "string" ? agreed : version;
          break;
        }
        lastProblem = reply?.error?.message
          ? `The server refused the MCP handshake: ${reply.error.message}`
          : lastProblem;
      } catch (cause) {
        if (cause instanceof NeedsAuth) throw cause;
        if (!(cause instanceof ProbeFailure) || !/HTTP 4\d\d/.test(cause.message)) throw cause;
        lastProblem = cause.message;
      }
    }
    if (!initialized) throw new ProbeFailure(lastProblem);

    await send({ method: "notifications/initialized" }, false).catch((cause) => {
      if (cause instanceof NeedsAuth) throw cause;
    });

    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES && names.length < MCP_PROBE_MAX_TOOLS; page += 1) {
      const reply = await send(
        { method: "tools/list", ...(cursor !== undefined ? { params: { cursor } } : {}) },
        true,
      );
      if (reply?.error) {
        throw new ProbeFailure(
          `The server couldn't list its tools${reply.error.message ? `: ${reply.error.message}` : "."}`,
        );
      }
      const result = (reply?.result ?? {}) as { tools?: unknown; nextCursor?: unknown };
      if (Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          const name = (tool as { name?: unknown } | null)?.name;
          if (typeof name === "string" && names.length < MCP_PROBE_MAX_TOOLS) names.push(name);
        }
      }
      if (typeof result.nextCursor !== "string" || result.nextCursor.length === 0) break;
      cursor = result.nextCursor;
    }

    return {
      ok: true,
      toolCount: names.length,
      toolNames: names.slice(0, MCP_PROBE_TOOL_NAMES_SHOWN),
      needsAuth: false,
      error: null,
    };
  } catch (cause) {
    if (cause instanceof NeedsAuth) {
      return {
        ok: false,
        toolCount: 0,
        toolNames: [],
        needsAuth: true,
        error: "This server asks you to sign in.",
      };
    }
    return failed(describeFetchError(cause));
  } finally {
    if (sessionId) {
      await guardedFetch(
        url,
        {
          method: "DELETE",
          headers: {
            "mcp-session-id": sessionId,
            ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
          },
          signal: AbortSignal.timeout(2_000),
        },
        {
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.lookup ? { lookup: options.lookup } : {}),
        },
      )
        .then((response) => response.body?.cancel())
        .catch(() => undefined);
    }
  }
}
