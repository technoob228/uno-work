/**
 * `/goal`: the agent keeps taking turns until the goal is met. This module is
 * the rules; `apps/server/src/goal/` runs them.
 *
 * The person's first message goes out as an ordinary message. After each turn
 * the computer asks the agent, in a note, to check the goal and either go on
 * or say it is done with a line only that goal knows (`nonce`). Each turn
 * starts in the chat's own access mode: a goal never raises it.
 */

export const GOAL_MAX_TURNS = 10;
export const GOAL_MAX_MINUTES = 60;
export const GOAL_MAX_COST_USD = 10;
export const GOAL_COMMAND_PREFIX = "goal:";
export const GOAL_ORIGIN_COMPONENT = "thread-goal";

export type GoalCommand =
  | { readonly kind: "help" }
  | { readonly kind: "stop" }
  | { readonly kind: "set"; readonly goal: string };

/** `/goal <what done means>`, `/goal stop`; null for any other text. */
export function parseGoalCommand(text: string): GoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const rest = match[1]?.trim() ?? "";
  if (rest.length === 0) return { kind: "help" };
  if (/^(stop|clear|cancel)$/i.test(rest)) return { kind: "stop" };
  return { kind: "set", goal: rest };
}

const MARKER = /^[ \t>*_`]*GOAL (MET|BLOCKED) ([0-9a-f]{6})\b[:\s-]*(.*)$/gm;

export function goalNoteBody(input: {
  readonly goal: string;
  readonly nonce: string;
  readonly turn: number;
  readonly maxTurns: number;
}): string {
  return (
    `Goal check, turn ${input.turn} of ${input.maxTurns}. The goal: ${input.goal}\n` +
    `Check it for real, by running it or looking at the result, not from memory. ` +
    `If it is fully met, end your reply with the line "GOAL MET ${input.nonce}". ` +
    `If you cannot go on without the person, end with "GOAL BLOCKED ${input.nonce}: why". ` +
    `Otherwise keep working toward it. Don't say it is met to stop early.`
  );
}

/** The quiet line a goal's note shows in the chat, or null if it is not one. */
export function goalNoteLine(body: string): string | null {
  const match = /^Goal check, turn (\d+) of (\d+)\./.exec(body);
  return match ? `Goal: turn ${match[1]} of ${match[2]}.` : null;
}

export type GoalVerdict =
  | { readonly verdict: "met" }
  | { readonly verdict: "blocked"; readonly reason: string }
  | null;

/** The last marker with this goal's nonce: an agent can quote an earlier one. */
export function readGoalVerdict(text: string, nonce: string): GoalVerdict {
  let verdict: GoalVerdict = null;
  for (const match of text.matchAll(MARKER)) {
    if (match[2] !== nonce) continue;
    verdict =
      match[1] === "MET"
        ? { verdict: "met" }
        : { verdict: "blocked", reason: (match[3] ?? "").trim() };
  }
  return verdict;
}

/** The marker is for the computer: the person never sees it. */
export function stripGoalMarker(text: string): string {
  return text.replace(MARKER, "").trimEnd();
}

export interface GoalProgress {
  readonly turnsUsed: number;
  readonly maxTurns: number;
  readonly costUsd: number | null;
  readonly maxCostUsd: number;
  readonly deadlineMs: number;
}

export type GoalStep =
  | { readonly next: "continue" }
  | {
      readonly next: "end";
      readonly status: "met" | "blocked" | "limit" | "stopped";
      readonly note: string;
    };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What happens after a turn ended well. The agent's word comes before any ceiling. */
export function decideGoalStep(input: {
  readonly progress: GoalProgress;
  readonly verdict: GoalVerdict;
  readonly holdsOutsideInput: boolean;
  readonly now: number;
}): GoalStep {
  const { progress, verdict, holdsOutsideInput, now } = input;
  if (verdict?.verdict === "met") {
    return {
      next: "end",
      status: "met",
      note: `Goal met in ${plural(progress.turnsUsed, "turn")}.`,
    };
  }
  if (verdict?.verdict === "blocked") {
    return {
      next: "end",
      status: "blocked",
      note: verdict.reason.length > 0 ? `Needs you: ${verdict.reason}` : "The agent needs you.",
    };
  }
  if (holdsOutsideInput) {
    return {
      next: "end",
      status: "stopped",
      note: "Stopped: this chat got text from outside.",
    };
  }
  if (progress.turnsUsed >= progress.maxTurns) {
    return {
      next: "end",
      status: "limit",
      note: `Stopped at the limit of ${plural(progress.maxTurns, "turn")}.`,
    };
  }
  if (progress.costUsd !== null && progress.costUsd >= progress.maxCostUsd) {
    return { next: "end", status: "limit", note: `Stopped at the $${progress.maxCostUsd} limit.` };
  }
  if (now >= progress.deadlineMs) {
    return {
      next: "end",
      status: "limit",
      note: `Stopped at the ${GOAL_MAX_MINUTES} minute limit.`,
    };
  }
  return { next: "continue" };
}

/**
 * Cost a provider reports after a turn: Claude's is the session's running
 * total, so what counts is what it grew by. A drop means a new session.
 */
export function addReportedCost(
  state: { readonly usedUsd: number; readonly lastReportedUsd: number | null },
  reportedUsd: number,
): { readonly usedUsd: number; readonly lastReportedUsd: number } {
  const last = state.lastReportedUsd;
  const added = last === null ? 0 : reportedUsd >= last ? reportedUsd - last : reportedUsd;
  return { usedUsd: state.usedUsd + added, lastReportedUsd: reportedUsd };
}
