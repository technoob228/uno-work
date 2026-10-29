/**
 * Long tool results for the Uno dispatcher, cut. Every result stays in its
 * conversation and is re-sent with every later step (29.10: 100k+ input
 * tokens a step); a dispatcher needs the gist — the rest a chat reads.
 *
 * @module mcp/capToolResult
 */
export const DISPATCHER_TOOL_RESULT_MAX_CHARS = 4_000;

const cutNote = (more: number) =>
  `\n…[cut: ${more} more characters. Ask a narrower question (one chat, fewer messages), or hand the reading to a chat.]`;

/** A text cut to `max` characters with a note of what is left; unchanged when it fits. */
export function capText(text: string, max = DISPATCHER_TOOL_RESULT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 160);
  return `${text.slice(0, keep)}${cutNote(text.length - keep)}`;
}

/**
 * A JSON-RPC response body whose `result.content[]` text blocks are cut
 * ({@link capText}); anything else comes back as it is.
 */
export function capToolResultBody(body: unknown, max = DISPATCHER_TOOL_RESULT_MAX_CHARS): unknown {
  if (typeof body !== "object" || body === null) return body;
  const result = (body as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return body;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return body;
  let changed = false;
  const capped = content.map((block: unknown) => {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const text = (block as { text: string }).text;
      const next = capText(text, max);
      if (next !== text) {
        changed = true;
        return { ...block, text: next };
      }
    }
    return block;
  });
  if (!changed) return body;
  const { structuredContent: _dropped, ...rest } = result as Record<string, unknown>;
  return { ...body, result: { ...rest, content: capped } };
}
