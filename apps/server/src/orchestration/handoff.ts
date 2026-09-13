/**
 * Handoff seeds: carrying the recent history of one thread into the first
 * turn of another.
 *
 * Two consumers today:
 * - the Telegram connector, when a chat is re-pointed at a replacement thread
 *   (harness switch, archived thread) — a small budget, prepended to the body
 *   of the very next incoming message;
 * - "Continue on <machine>", which seeds the new thread on the target daemon
 *   with a larger budget. The seed is stored as the first user message of the
 *   new thread and folded into the prompt of the first real turn
 *   (`resolvePendingHandoffSeed`), so the harness sees it without anything
 *   running automatically.
 *
 * The preamble markers are shared so a thread that itself started from a
 * handoff can be handed off again without nesting preambles.
 */
import type { OrchestrationMessage } from "@t3tools/contracts";
import {
  CONTINUE_SEED_PREFIX,
  HANDOFF_PREAMBLE_END,
  HANDOFF_PREAMBLE_START,
  HANDOFF_PREAMBLE_STARTS,
  LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START,
} from "@t3tools/shared/handoff";

// The marker strings live in `@t3tools/shared/handoff` so the web app can
// recognise a seed without duplicating them; re-exported for existing callers.
export {
  CONTINUE_SEED_PREFIX,
  HANDOFF_PREAMBLE_END,
  HANDOFF_PREAMBLE_START,
  LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START,
};

export interface HandoffContextOptions {
  /** How many of the most recent user/assistant messages to carry. */
  readonly messageCount: number;
  /** Per-message character budget; longer messages are cut with an ellipsis. */
  readonly messageChars: number;
  /** Extra per-message cleanup (e.g. dropping connector hints) applied after preamble stripping. */
  readonly sanitize?: (text: string) => string;
}

/** Telegram-sized budget: a dozen short lines. */
export const TELEGRAM_HANDOFF_OPTIONS: HandoffContextOptions = {
  messageCount: 12,
  messageChars: 600,
};

/** "Continue on <machine>" budget: enough to resume real work. */
export const CONTINUE_HANDOFF_OPTIONS: HandoffContextOptions = {
  messageCount: 40,
  messageChars: 4_000,
};

/**
 * Drop an inherited preamble from a message that itself opened a handed-off
 * thread. Also drops a whole "Continue on <machine>" seed, which is a
 * preamble with a header line in front of it.
 */
export const stripHandoffPreamble = (text: string): string => {
  const startIndex = HANDOFF_PREAMBLE_STARTS.map((marker) => text.indexOf(marker)).find(
    (index) => index !== -1,
  );
  if (startIndex === undefined) {
    return text;
  }
  const headOnly = text.slice(0, startIndex).trim();
  // A preamble in the middle of a message is not a preamble we produced.
  if (headOnly.length > 0 && !headOnly.startsWith(CONTINUE_SEED_PREFIX)) {
    return text;
  }
  const endIndex = text.indexOf(HANDOFF_PREAMBLE_END, startIndex);
  if (endIndex === -1) {
    return text;
  }
  return text.slice(endIndex + HANDOFF_PREAMBLE_END.length).replace(/^\s+/, "");
};

type HandoffMessage = Pick<OrchestrationMessage, "role" | "text" | "streaming">;

/**
 * Compact transcript of a thread: `User:` / `Assistant:` lines, oldest first,
 * within the given budget. `null` when nothing is worth carrying.
 */
export const buildHandoffContext = (
  thread: { readonly messages: ReadonlyArray<HandoffMessage> },
  options: HandoffContextOptions,
): string | null => {
  const recent = thread.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !message.streaming &&
        message.text.trim().length > 0,
    )
    .slice(-options.messageCount);
  if (recent.length === 0) {
    return null;
  }
  const lines = recent.flatMap((message) => {
    const role = message.role === "assistant" ? "Assistant" : "User";
    // If the old thread itself started from a handoff, its first user
    // message carries a preamble of the thread before it. Strip it, or
    // repeated handoffs nest preambles inside preambles.
    const withoutPreamble = stripHandoffPreamble(message.text);
    const sanitized = options.sanitize ? options.sanitize(withoutPreamble) : withoutPreamble;
    if (sanitized.trim().length === 0) {
      return [];
    }
    const text =
      sanitized.length > options.messageChars
        ? `${sanitized.slice(0, options.messageChars)}…`
        : sanitized;
    return [`${role}: ${text}`];
  });
  return lines.length === 0 ? null : lines.join("\n");
};

/** Wrap a transcript in the shared preamble markers. */
export const wrapHandoffPreamble = (context: string): string =>
  [HANDOFF_PREAMBLE_START, context, HANDOFF_PREAMBLE_END].join("\n");

export interface ContinueSeedInput {
  readonly thread: { readonly title: string; readonly messages: ReadonlyArray<HandoffMessage> };
  readonly sourceMachineLabel: string;
  /** Branch the source workspace was on; null when detached or unknown. */
  readonly sourceBranch: string | null;
  readonly options?: HandoffContextOptions;
}

/**
 * The first user message of a continued thread: a one-paragraph header that
 * says where the chat came from and that the files travelled with it, then
 * the recent history in the shared preamble.
 */
export const buildContinueSeed = (input: ContinueSeedInput): string => {
  const options = input.options ?? CONTINUE_HANDOFF_OPTIONS;
  const branchNote = input.sourceBranch ? ` on branch "${input.sourceBranch}"` : "";
  const header =
    `${CONTINUE_SEED_PREFIX}${input.sourceMachineLabel}] This chat continues "${input.thread.title}" from ${input.sourceMachineLabel}${branchNote}. ` +
    "The project files were carried over exactly as they were there, including uncommitted changes, so the working tree already reflects the work below. " +
    "Pick up where the conversation left off.";
  const context = buildHandoffContext(input.thread, options);
  if (context === null) {
    return header;
  }
  return [header, "", wrapHandoffPreamble(context)].join("\n");
};

/** Note appended to a seed when the target machine runs a different model than the source did. */
export const buildModelFallbackNote = (input: {
  readonly sourceMachineLabel: string;
  readonly requested: { readonly instanceId: string; readonly model: string };
  readonly applied: { readonly instanceId: string; readonly model: string };
}): string =>
  `[Note: the model used on ${input.sourceMachineLabel} (${input.requested.instanceId} / ${input.requested.model}) is not installed here; this chat runs on ${input.applied.instanceId} / ${input.applied.model}.]`;

export const isContinueSeedText = (text: string): boolean => text.startsWith(CONTINUE_SEED_PREFIX);

/**
 * Seed text to prepend to the prompt of a turn, if the thread was seeded by
 * "Continue on <machine>" and no turn has run yet. The seed is the earlier
 * user message(s) with no turn; once the harness has answered, its own
 * session history holds the context and nothing is prepended again.
 */
export const resolvePendingHandoffSeed = (input: {
  readonly messages: ReadonlyArray<
    Pick<OrchestrationMessage, "role" | "text"> & {
      readonly id: string;
      readonly turnId: string | null;
    }
  >;
  readonly currentMessageId: string;
}): string | null => {
  if (input.messages.some((message) => message.role === "assistant")) {
    return null;
  }
  const seeds: string[] = [];
  for (const message of input.messages) {
    if (message.id === input.currentMessageId) {
      break;
    }
    if (message.role === "user" && message.turnId === null && isContinueSeedText(message.text)) {
      seeds.push(message.text);
    }
  }
  return seeds.length === 0 ? null : seeds.join("\n\n");
};

/** Prompt for a turn: pending seed first, then what the person typed. */
export const applyHandoffSeed = (seed: string | null, messageText: string): string =>
  seed === null ? messageText : `${seed}\n\n${messageText}`;
