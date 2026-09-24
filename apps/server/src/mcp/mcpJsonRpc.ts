/**
 * Stateless MCP (Model Context Protocol) server core, shared by every MCP
 * surface of the daemon (`uno-manager` for assistants, `uno-work` for every
 * chat).
 *
 * Implements the Streamable HTTP transport in its simplest legal form: every
 * client POST carries one JSON-RPC message and gets a plain
 * `application/json` response (no SSE stream, no server-side session state).
 * That keeps an endpoint a pure function of (capability token, request) and
 * avoids pulling the official SDK's Express-style transport into the Effect
 * HTTP router. Verified against MCP protocol revisions 2024-11-05 through
 * 2025-06-18 for the initialize / tools/list / tools/call / ping subset.
 */
import { Effect } from "effect";

const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", LATEST_PROTOCOL_VERSION]);

/** MCP tool annotations (2025-03-26+): hints clients may show or act on. */
export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * A tool result that is already MCP content (e.g. an image block for a
 * screenshot) — sent as is instead of being stringified.
 */
export class McpContent {
  readonly content: ReadonlyArray<Record<string, unknown>>;
  constructor(content: ReadonlyArray<Record<string, unknown>>) {
    this.content = content;
  }
}

export interface McpToolDefinition<Ctx, E> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: McpToolAnnotations;
  readonly run: (ctx: Ctx, args: unknown) => Effect.Effect<unknown, E>;
}

export interface McpServerDefinition<Ctx, E> {
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** Sent in `initialize` — clients that support it add it to the model's context. */
  readonly instructions?: string;
  readonly tools: ReadonlyArray<McpToolDefinition<Ctx, E>>;
  /** Text the model sees when a tool fails. */
  readonly errorText: (error: E) => string;
  /** A successful result as MCP content text (default: JSON). */
  readonly resultText?: (result: unknown) => string;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export type McpHandleOutcome =
  | { readonly kind: "response"; readonly body: unknown }
  | { readonly kind: "accepted" };

export function jsonRpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (message as { method?: unknown }).method === "string"
  );
}

const defaultResultText = (result: unknown): string =>
  typeof result === "string" ? result : JSON.stringify(result);

/** The `tools/list` entry of a tool (what the model sees). */
export function describeMcpTool<Ctx, E>(tool: McpToolDefinition<Ctx, E>) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

/**
 * Handle one decoded JSON-RPC message on behalf of an authenticated caller.
 * Returns `accepted` for notifications (HTTP 202, no body).
 */
export function handleMcpMessage<Ctx, E>(
  server: McpServerDefinition<Ctx, E>,
  ctx: Ctx,
  message: unknown,
): Effect.Effect<McpHandleOutcome> {
  return Effect.gen(function* () {
    if (Array.isArray(message)) {
      return {
        kind: "response",
        body: jsonRpcError(null, -32600, "Batch requests are not supported."),
      } as const;
    }
    if (!isJsonRpcRequest(message)) {
      return {
        kind: "response",
        body: jsonRpcError(null, -32600, "Expected a JSON-RPC 2.0 request."),
      } as const;
    }

    // Notifications (no id) get acknowledged without a body.
    if (message.id === undefined || message.id === null) {
      return { kind: "accepted" } as const;
    }
    const id = message.id;

    switch (message.method) {
      case "initialize": {
        const requested =
          typeof message.params === "object" &&
          message.params !== null &&
          typeof (message.params as { protocolVersion?: unknown }).protocolVersion === "string"
            ? ((message.params as { protocolVersion: string }).protocolVersion satisfies string)
            : LATEST_PROTOCOL_VERSION;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return {
          kind: "response",
          body: jsonRpcResult(id, {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: server.serverInfo,
            ...(server.instructions ? { instructions: server.instructions } : {}),
          }),
        } as const;
      }
      case "ping": {
        return { kind: "response", body: jsonRpcResult(id, {}) } as const;
      }
      case "tools/list": {
        return {
          kind: "response",
          body: jsonRpcResult(id, { tools: server.tools.map(describeMcpTool) }),
        } as const;
      }
      case "tools/call": {
        const params = (message.params ?? {}) as {
          readonly name?: unknown;
          readonly arguments?: unknown;
        };
        const tool = server.tools.find((candidate) => candidate.name === params.name);
        if (tool === undefined) {
          return {
            kind: "response",
            body: jsonRpcError(id, -32602, `Unknown tool: ${String(params.name)}`),
          } as const;
        }
        const resultText = server.resultText ?? defaultResultText;
        const outcome = yield* tool.run(ctx, params.arguments).pipe(
          Effect.map((result) => ({
            content:
              result instanceof McpContent
                ? result.content
                : [{ type: "text", text: resultText(result) }],
            isError: false,
          })),
          Effect.catch((error: E) =>
            Effect.succeed({
              content: [{ type: "text", text: server.errorText(error) }],
              isError: true,
            }),
          ),
        );
        return { kind: "response", body: jsonRpcResult(id, outcome) } as const;
      }
      default: {
        return {
          kind: "response",
          body: jsonRpcError(id, -32601, `Method not found: ${message.method}`),
        } as const;
      }
    }
  });
}
