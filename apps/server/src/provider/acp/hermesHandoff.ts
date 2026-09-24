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
