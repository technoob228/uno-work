/**
 * Home's starter hints, made from what the person's recent chats actually
 * said (Misha 13.10: "Next step for «title»" is dumb). A small model reads the
 * end of up to three chats through the Uno gateway and proposes concrete
 * follow-ups — a failing check, a promised next step, an open question — in the
 * language of the chat. Nothing to propose is a valid answer.
 *
 * Pure parts (prompt, parsing) live here with the gateway call; the route is
 * homeSuggestionsHttp.ts.
 */
import { UNO_FAST_GATEWAY_MODEL, UNO_GATEWAY_BASE_URL } from "@t3tools/contracts";

export const MAX_SUGGESTION_CHATS = 3;
export const MAX_SUGGESTIONS = 3;
const MESSAGES_PER_CHAT = 6;
const MESSAGE_CHARS = 700;
const LABEL_CHARS = 44;
const TASK_CHARS = 320;
const GATEWAY_TIMEOUT_MS = 25_000;

export interface SuggestionChat {
  readonly threadId: string;
  readonly title: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}

export interface HomeSuggestion {
  readonly threadId: string;
  readonly label: string;
  readonly prompt: string;
}

const SYSTEM_PROMPT = `You write one-click hints for the home screen of a person's AI computer. You see the end of their recent chats with the AI.

Suggest up to ${MAX_SUGGESTIONS} concrete next tasks that continue THEIR work: an item the AI said is still open, a check or test that failed, a step that was promised, a question left unanswered, an obvious follow-up of what was just done.

Rules:
- Specific to the chat: name the thing (the file, the page, the bug, the number). Never generic ("continue", "next step", "summarize this chat", "improve it").
- Skip a chat that is finished with nothing open. If nothing is worth suggesting, answer [].
- Write in the language of that chat.
- "label" is the button: at most ${LABEL_CHARS} characters, starts with a verb, no quotes around chat titles.
- "task" is the message the person would send: one or two sentences, in the first person, self-contained.
- At most one hint per chat.

Answer with JSON only: [{"chat": <number of the chat>, "label": "...", "task": "..."}]`;

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** The end of each chat, numbered, as one user message. */
export function buildSuggestionMessages(chats: ReadonlyArray<SuggestionChat>) {
  const blocks = chats.map((chat, index) => {
    const tail = chat.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .filter((message) => message.text.trim().length > 0)
      .slice(-MESSAGES_PER_CHAT)
      .map(
        (message) =>
          `${message.role === "user" ? "Person" : "AI"}: ${clip(message.text, MESSAGE_CHARS)}`,
      );
    return `Chat ${index + 1}: ${clip(chat.title, 80)}\n${tail.join("\n")}`;
  });
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: blocks.join("\n\n---\n\n") },
  ];
}

/** Tolerant of code fences and prose around the JSON; strict about the fields. */
export function parseSuggestions(
  raw: string,
  chats: ReadonlyArray<Pick<SuggestionChat, "threadId">>,
): HomeSuggestion[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: HomeSuggestion[] = [];
  const usedChats = new Set<number>();
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const chatNumber = typeof entry["chat"] === "number" ? entry["chat"] : Number.NaN;
    const chat = chats[chatNumber - 1];
    const label = typeof entry["label"] === "string" ? entry["label"].trim() : "";
    const task = typeof entry["task"] === "string" ? entry["task"].trim() : "";
    if (!chat || usedChats.has(chatNumber) || label.length < 3 || task.length < 8) continue;
    usedChats.add(chatNumber);
    out.push({
      threadId: chat.threadId,
      label: clip(label, LABEL_CHARS),
      prompt: clip(task, TASK_CHARS),
    });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

export type SuggestionOutcome =
  | { readonly ok: true; readonly suggestions: HomeSuggestion[] }
  | { readonly ok: false; readonly reason: "no-key" | "gateway" };

export async function requestSuggestions(input: {
  readonly apiKey: string;
  readonly chats: ReadonlyArray<SuggestionChat>;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<SuggestionOutcome> {
  if (input.apiKey.trim().length === 0) return { ok: false, reason: "no-key" };
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${input.baseUrl ?? UNO_GATEWAY_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: UNO_FAST_GATEWAY_MODEL,
        messages: buildSuggestionMessages(input.chats),
        max_tokens: 500,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "gateway" };
    const body = (await response.json()) as {
      choices?: ReadonlyArray<{ message?: { content?: unknown } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    return {
      ok: true,
      suggestions: typeof content === "string" ? parseSuggestions(content, input.chats) : [],
    };
  } catch {
    return { ok: false, reason: "gateway" };
  }
}
