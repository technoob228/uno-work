/**
 * Handoff preamble markers, shared between the server (which builds seeds in
 * `orchestration/handoff.ts`) and the web app (which recognises a seed in the
 * chat timeline and renders it collapsed). Strings live here once so the two
 * sides cannot drift apart.
 */

export const HANDOFF_PREAMBLE_START =
  "[Context: this conversation continues an earlier thread. Recent history, oldest first:]";
export const HANDOFF_PREAMBLE_END = "[End of context. Reply to the message below.]";

/**
 * Marker the Telegram connector used before the preamble became shared. Kept
 * so preambles already persisted in old threads are still recognised.
 */
export const LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START =
  "[Context: this Telegram chat previously ran in another thread (the harness/model was switched). Recent history, oldest first:]";

export const HANDOFF_PREAMBLE_STARTS: ReadonlyArray<string> = [
  HANDOFF_PREAMBLE_START,
  LEGACY_TELEGRAM_HANDOFF_PREAMBLE_START,
];

/** First line of a "Continue on <machine>" seed: `[Continued from <machine>] …`. */
export const CONTINUE_SEED_PREFIX = "[Continued from ";

/**
 * The quiet line in a chat's feed: the chat moved to another agent (or
 * account). Written by the daemon when the new agent's turn starts.
 */
export const AGENT_SWITCH_ACTIVITY_KIND = "chat.agent-switched";

export interface AgentSwitchActivityPayload {
  /** Who the chat moved to, as the picker names it. */
  readonly to: string;
  readonly toInstanceId: string;
  readonly fromInstanceId: string;
  /** Saved items the new agent got whole, out of all there were. */
  readonly carried: number;
  readonly total: number;
  /** Turns the chat had before the move: a revert to here or earlier empties the new session. */
  readonly turnCount: number;
  /** Already said in the chat, by "Continue with <account>"'s note. */
  readonly silent?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads a stored line back; null for anything else, a payload from another version included. */
export const readAgentSwitch = (payload: unknown): AgentSwitchActivityPayload | null => {
  if (!isRecord(payload)) return null;
  const { to, toInstanceId, fromInstanceId, carried, total, turnCount, silent } = payload;
  if (
    typeof to !== "string" ||
    typeof toInstanceId !== "string" ||
    typeof fromInstanceId !== "string" ||
    typeof carried !== "number" ||
    typeof total !== "number" ||
    typeof turnCount !== "number"
  ) {
    return null;
  }
  return {
    to,
    toInstanceId,
    fromInstanceId,
    carried,
    total,
    turnCount,
    ...(silent === true ? { silent: true } : {}),
  };
};

/** "Switched to Claude", and how much went along when some of it stayed behind. */
export const agentSwitchLine = (input: {
  readonly to: string;
  readonly carried: number;
  readonly total: number;
}): string =>
  input.carried < input.total
    ? `Switched to ${input.to} · ${input.carried} of ${input.total} items carried over`
    : `Switched to ${input.to}`;

/**
 * Ask mode holds on this agent. It doesn't on Hermes: its modes cover edits, a
 * shell command asks only on a pattern list.
 */
export const askHoldsOnAgent = (agent: {
  readonly instanceId: string;
  readonly driverKind?: string | undefined;
}): boolean => agent.driverKind !== "hermes" && !/hermes/i.test(agent.instanceId);

/** A stranger's text (a webhook's body, a site form) sits in this user message. */
export const messageHoldsOutsideText = (message: {
  readonly role: string;
  readonly text: string;
}): boolean => message.role === "user" && message.text.includes("<outside_input_");
