/**
 * ONE next step for the person, from their goal and what the account already
 * has (Rama 26.09: the console said "Get Plus / Pick your AI", Home said "get a
 * plan in Telegram every morning", Telegram said "no agent connected").
 *
 * The backend decides: `GET /api/v1/account/next-step` (contract:
 * reports/day_2026-09-27/next-step-contract.md) — the console's Overview reads
 * the same answer. Work only renders it: no rule table here, so a rule changed
 * on the backend shows up in Work without a release. No answer (not signed in,
 * account unreachable) → no card.
 *
 * Pure: no React, no fetch.
 */
import type { GoalId } from "../../setup/goals";
import { parseGoal } from "../../setup/goals";

export type NextStepStage = "start" | "first_result" | "growing";
export type GoalSource = "console" | "guessed" | "none";

export interface NextStepItem {
  /** The backend's step id; an id Work has no copy for still renders (title + console). */
  readonly id: string;
  readonly title: string;
  readonly hint: string | null;
  readonly done: boolean;
  /** Where the console does it (relative path on console.uno.place). */
  readonly consolePath: string | null;
}

export interface NextStepPlan {
  readonly goal: GoalId | null;
  readonly goalSource: GoalSource;
  readonly stage: NextStepStage;
  readonly next: NextStepItem | null;
  readonly steps: ReadonlyArray<NextStepItem>;
  readonly aiAvailable: boolean;
  readonly source: "backend";
}

/** users.onboarding_path → goal (goal-first values and the v2 ones). */
export function goalFromAccountPath(value: unknown): GoalId | null {
  switch (value) {
    case "agent":
    case "hardware":
    case "own_agent":
      return "own_agent";
    case "host":
      return "site";
    case "computer":
      return "server";
    case "work":
      return "assistant";
    default:
      return parseGoal(value);
  }
}

// ── the backend's answer ─────────────────────────────────────────────

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseItem(raw: unknown): NextStepItem | null {
  const r = rec(raw);
  const id = str(r?.["id"]);
  if (!r || !id) return null;
  return {
    id,
    title: str(r["title"]) ?? "",
    hint: str(r["hint"]),
    done: r["done"] === true,
    consolePath: str(r["console_path"]),
  };
}

/** `GET /api/v1/account/next-step` → plan; null when the shape isn't v1. */
export function parseNextStepPlan(raw: unknown): NextStepPlan | null {
  const r = rec(raw);
  if (!r || r["version"] !== 1) return null;
  const steps = Array.isArray(r["steps"])
    ? r["steps"].map(parseItem).filter((item): item is NextStepItem => item !== null)
    : [];
  const next = r["next"] === null ? null : parseItem(r["next"]);
  const stage = r["stage"];
  const source = r["goal_source"];
  const signals = rec(r["signals"]);
  return {
    goal: goalFromAccountPath(r["goal"]),
    goalSource: source === "console" || source === "guessed" ? source : "none",
    stage: stage === "first_result" || stage === "growing" ? stage : "start",
    next,
    steps,
    aiAvailable: signals?.["ai_available"] !== false,
    source: "backend",
  };
}

// ── what Home shows ─────────────────────────────────────────────────

/** Answers in settings.setup: a step taken here (ideas) or put off with "Not now". */
export const nextStepDoneKey = (id: string) => `next_done:${id}`;
export const nextStepSkipKey = (id: string) => `next_skip:${id}`;

/**
 * The backend's `next`, unless it was taken here a moment ago (an idea, before
 * the account catches up — then the next open step after it) or put off with
 * "Not now" (the card hides; it never jumps ahead to a step that needs this one).
 */
export function visibleNextStep(
  plan: NextStepPlan | null,
  answers: Readonly<Record<string, string>>,
): NextStepItem | null {
  if (!plan?.next) return null;
  let candidate: NextStepItem | null = plan.next;
  if (answers[nextStepDoneKey(candidate.id)]) {
    const from = plan.steps.findIndex((entry) => entry.id === plan.next?.id);
    candidate =
      plan.steps
        .slice(from + 1)
        .find((entry) => !entry.done && !answers[nextStepDoneKey(entry.id)]) ?? null;
  }
  return candidate && !answers[nextStepSkipKey(candidate.id)] ? candidate : null;
}

/**
 * SSH is not a first advice for someone who did not ask for a server
 * (flows v2, E7 / life-home/5): when the account's goal was only guessed from
 * what it has, and Dev mode is off, the card leads with the step after
 * "Connect with SSH" and SSH stays one small "For developers" link under it.
 * A person who picked the server goal, or has Dev mode on, sees it as before.
 */
export function withoutSshFirst(
  plan: NextStepPlan | null,
  step: NextStepItem | null,
  answers: Readonly<Record<string, string>>,
  devMode: boolean,
): { readonly step: NextStepItem | null; readonly developerStep: NextStepItem | null } {
  if (!plan || !step || step.id !== "connect_ssh" || devMode || plan.goalSource === "console") {
    return { step, developerStep: null };
  }
  const from = plan.steps.findIndex((entry) => entry.id === step.id);
  const after =
    plan.steps
      .slice(from + 1)
      .find(
        (entry) =>
          !entry.done &&
          !answers[nextStepDoneKey(entry.id)] &&
          !answers[nextStepSkipKey(entry.id)],
      ) ?? null;
  return { step: after, developerStep: step };
}

/**
 * The chat a "describe it to Uno" step continues (flows v2, B2 — the same rule
 * as the console's `stepChatHref`): the chat about the same thing when there is
 * one, else the newest chat; null → start a new one.
 */
export function nextStepChatId(
  stepId: string,
  resume:
    | {
        readonly botChatId: string | null;
        readonly siteChatId: string | null;
        readonly lastChatId: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!resume) return null;
  switch (stepId) {
    case "describe_bot":
      return resume.botChatId ?? resume.lastChatId;
    case "describe_site":
      return resume.siteChatId ?? resume.lastChatId;
    case "talk_to_uno":
      return resume.lastChatId;
    default:
      return null;
  }
}
