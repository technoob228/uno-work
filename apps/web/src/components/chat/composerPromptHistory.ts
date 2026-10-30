/**
 * ↑ in an empty message box brings back the last message you sent in this
 * chat; ↑ again goes further back, ↓ comes forward, and past the newest one
 * the box is empty again. Like a terminal's history.
 *
 * Ported from upstream T3 Code fd773172e7 (#9173), trimmed to what Work
 * appends at send time (terminal context, a screen recording block) and to
 * app-composed sends (attachments only, "implement this plan"). History is
 * per chat and text only, derived from the chat's messages on the keypress:
 * nothing is stored.
 */
import { buildPlanImplementationPrompt } from "../../proposedPlan";
import { extractRecordingBlock } from "../../screenRecording/recordingLogic";
import { extractQuotes } from "../../lib/chatQuotes";
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";

export interface ComposerPromptHistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  /** Another chat's agent wrote it: not the person's own words. */
  readonly sentByThreadId?: string | null | undefined;
}

export interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
}

/**
 * Active recall: `recalled` is the text put in the box. Once the box no
 * longer matches it, the person edited or sent, and browsing is over.
 */
export interface ComposerPromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

export interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null;
  readonly prompt: string;
}

// The bracketed text sent in place of an empty prompt with only attachments.
const ATTACHMENT_ONLY_PROMPT_PATTERN =
  /^\[User attached one or more [^\]]*without additional text\./;
const PLAN_IMPLEMENTATION_PREFIX = buildPlanImplementationPrompt("").trim();

/** The words the person typed, without what the app appended; "" when there are none. */
export function recallableComposerPrompt(text: string): string {
  const withoutRecording = extractRecordingBlock(text).text;
  const prompt = extractQuotes(
    deriveDisplayedUserMessageState(withoutRecording).visibleText,
  ).text.trim();
  if (ATTACHMENT_ONLY_PROMPT_PATTERN.test(prompt)) return "";
  if (prompt.startsWith(PLAN_IMPLEMENTATION_PREFIX)) return "";
  return prompt;
}

/**
 * Oldest first. Consecutive identical prompts collapse into the newest one
 * (shell `ignoredups`). Sends with no text are skipped.
 */
export function buildComposerPromptHistoryEntries(
  messages: ReadonlyArray<ComposerPromptHistoryMessage>,
): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.sentByThreadId != null) continue;
    const prompt = recallableComposerPrompt(message.text);
    if (prompt.length === 0) continue;
    const previous = entries.at(-1);
    if (previous && previous.prompt === prompt) {
      entries[entries.length - 1] = { id: message.id, prompt };
      continue;
    }
    entries.push({ id: message.id, prompt });
  }
  return entries;
}

function findActive(
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: ComposerPromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

/**
 * Null when the key should move the caret as usual. Backward starts only
 * from an empty box and stops at the oldest entry; forward past the newest
 * entry empties the box and ends browsing.
 */
export function stepComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly position: ComposerPromptHistoryPosition | null;
  readonly currentPrompt: string;
}): ComposerPromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex =
    position && position.recalled === currentPrompt ? findActive(entries, position) : -1;

  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }

  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "" };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}

/**
 * In a recalled multi-line prompt ↑ / ↓ first move the caret line by line;
 * they browse only from the first line (↑) or the last line (↓). Logical
 * lines: a soft-wrapped long line counts as one.
 */
export function isCaretOnPromptEdge(
  prompt: string,
  cursor: number,
  edge: "start" | "end",
): boolean {
  const clamped = Math.max(0, Math.min(cursor, prompt.length));
  return edge === "start"
    ? !prompt.slice(0, clamped).includes("\n")
    : !prompt.slice(clamped).includes("\n");
}
