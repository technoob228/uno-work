/**
 * Handoff into a fresh Hermes session of a chat that already has history.
 *
 * The Uno assistant chat moved to Hermes in 0.0.84. Its earlier turns ran on
 * another harness whose session Hermes cannot load, and a Hermes session that
 * could not be resumed starts empty too. What the person sees in the chat is
 * the continuity that counts, so the first prompt of such a session carries
 * the visible conversation (bounded) and, in an assistant workspace, its
 * NOTES.md — the assistant's memory file. AGENTS.md needs no help: Hermes
 * loads it from the session's working directory into its system prompt.
 *
 * Pure: the adapter reads the files and decides when a session is fresh.
 *
 * @module provider/acp/hermesHandoff
 */
import type { ProviderContextMessage } from "@t3tools/contracts";

/** Budget of the carried conversation (oldest messages drop first). */
export const HERMES_HANDOFF_MAX_CONVERSATION_CHARS = 16_000;
export const HERMES_HANDOFF_MAX_MESSAGE_CHARS = 4_000;
export const HERMES_HANDOFF_MAX_MESSAGES = 30;
export const HERMES_HANDOFF_MAX_NOTES_CHARS = 8_000;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n[…truncated]`;
}

/**
 * The messages before the current one, newest kept within budget, oldest
 * first. The reactor appends the current message to the context; it is not
 * history.
 */
export function selectHandoffHistory(
  contextMessages: ReadonlyArray<ProviderContextMessage>,
  currentText: string,
): ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }> {
  const messages = [...contextMessages];
  const last = messages.at(-1);
  if (last?.role === "user" && last.text.trim() === currentText.trim()) {
    messages.pop();
  }
  const kept: Array<{ role: "user" | "assistant"; text: string }> = [];
  let total = 0;
  for (const message of messages.toReversed()) {
    if (message.role === "system") continue;
    const text = clip(message.text, HERMES_HANDOFF_MAX_MESSAGE_CHARS);
    if (text.length === 0) continue;
    if (kept.length >= HERMES_HANDOFF_MAX_MESSAGES) break;
    if (total + text.length > HERMES_HANDOFF_MAX_CONVERSATION_CHARS && kept.length > 0) break;
    kept.push({ role: message.role, text });
    total += text.length;
  }
  return kept.toReversed();
}

/**
 * The prompt of the first turn of a fresh session: the carried context, then
 * the person's message. Returns the message unchanged when there is nothing
 * to carry.
 */
export function buildHermesHandoffPrompt(input: {
  readonly currentText: string;
  readonly contextMessages: ReadonlyArray<ProviderContextMessage>;
  readonly notes: string | null;
}): string {
  const history = selectHandoffHistory(input.contextMessages, input.currentText);
  const notes = input.notes?.trim() ? clip(input.notes, HERMES_HANDOFF_MAX_NOTES_CHARS) : null;
  if (history.length === 0 && notes === null) return input.currentText;

  const sections: Array<string> = [
    "[Context carried over. This chat continues on a new engine: earlier turns ran in a session you cannot load. " +
      "Below is what the person sees in this chat so far (oldest first)" +
      (notes !== null ? " and your NOTES.md" : "") +
      ". Treat it as your own history — do not repeat or summarise it unless asked.]",
  ];
  if (history.length > 0) {
    sections.push(
      [
        "<conversation_so_far>",
        ...history.map((entry) => `${entry.role === "user" ? "Person" : "You"}: ${entry.text}`),
        "</conversation_so_far>",
      ].join("\n"),
    );
  }
  if (notes !== null) {
    sections.push(["<notes_md>", notes, "</notes_md>"].join("\n"));
  }
  sections.push(`Current message:\n${input.currentText}`);
  return sections.join("\n\n");
}

// ── The assistant's own files in the system prompt ──────────────────────

/** Budgets of the assistant's files in its session's system prompt. */
export const ASSISTANT_CONTEXT_SOUL_CHARS = 3_000;
export const ASSISTANT_CONTEXT_USER_CHARS = 3_000;
export const ASSISTANT_CONTEXT_NOTES_CHARS = 6_000;
export const ASSISTANT_CONTEXT_ROUTING_CHARS = 3_000;

/** ROUTING.md without its logs: the table and notes above "## Outcomes log". */
function routingTable(routing: string): string | null {
  const cut = routing.search(/^## Outcomes log/m);
  const head = (cut >= 0 ? routing.slice(0, cut) : routing).trim();
  return head.includes("|") ? head : null;
}

/** A file that is only its seeded heading ("# Who I am") says nothing. */
function meaningful(text: string): string | null {
  const body = text
    .split("\n")
    .filter((line) => !/^#\s/.test(line.trim()))
    .join("\n")
    .trim();
  return body.length > 0 ? text.trim() : null;
}

/** The newest part of NOTES.md (entries are appended): its end, cut at a line. */
function notesTail(notes: string, max: number): string {
  const trimmed = notes.trim();
  if (trimmed.length <= max) return trimmed;
  const tail = trimmed.slice(-max);
  const firstBreak = tail.indexOf("\n");
  return `[…older notes omitted — read NOTES.md for them]\n${firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail}`;
}

/**
 * An assistant session's own files as one block for Hermes'
 * `agent.environment_hint` (the stable, cached part of its system prompt):
 * who it is (SOUL.md), the person (USER.md), the newest NOTES.md and the
 * ROUTING.md table (read before every hand-off). Hermes
 * already loads AGENTS.md from the working directory, and SOUL.md only from
 * its HERMES_HOME (where it would replace Hermes' own identity), so these
 * would otherwise cost a file read on every status or dispatch turn.
 *
 * A snapshot of the session start: the files on disk win if they changed.
 * `withNotes`: the fresh-session handoff then carries no second copy.
 */
export function buildAssistantContextHint(input: {
  readonly soul: string;
  readonly user: string;
  readonly notes: string;
  readonly routing: string;
  /** Its duties and rules from its team record (`assistants/profileHint.ts`). */
  readonly profile?: string | null;
  readonly readAt: string;
}): { readonly hint: string; readonly withNotes: boolean } | null {
  const soul = meaningful(input.soul);
  const user = meaningful(input.user);
  const notes = meaningful(input.notes);
  const routing = routingTable(input.routing);
  const profile = input.profile?.trim() ? input.profile.trim() : null;
  if (soul === null && user === null && notes === null && routing === null && profile === null) {
    return null;
  }
  const sections = [
    `[Your own files in this assistant folder, as read when this session started (${input.readAt}). ` +
      "You do not need to read them again for a status or a hand-off; the files win if you or the person changed them since.]",
  ];
  if (profile !== null) {
    sections.push(
      `<Your profile — Uno Work keeps it, the person edits it on your page>\n${profile}\n</Your profile>`,
    );
  }
  if (soul !== null)
    sections.push(`<SOUL.md>\n${clip(soul, ASSISTANT_CONTEXT_SOUL_CHARS)}\n</SOUL.md>`);
  if (user !== null)
    sections.push(`<USER.md>\n${clip(user, ASSISTANT_CONTEXT_USER_CHARS)}\n</USER.md>`);
  if (notes !== null) {
    sections.push(`<NOTES.md>\n${notesTail(notes, ASSISTANT_CONTEXT_NOTES_CHARS)}\n</NOTES.md>`);
  }
  if (routing !== null) {
    sections.push(
      `<ROUTING.md table>\n${clip(routing, ASSISTANT_CONTEXT_ROUTING_CHARS)}\n</ROUTING.md table>`,
    );
  }
  return { hint: sections.join("\n\n"), withNotes: notes !== null };
}
