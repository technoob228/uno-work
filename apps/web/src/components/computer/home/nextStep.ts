/**
 * ONE next step for the person, from their goal and what the account already
 * has (Rama 26.09: the console said "Get Plus / Pick your AI", Home said "get a
 * plan in Telegram every morning", Telegram said "no agent connected").
 *
 * The source of truth is the backend: `GET /api/v1/account/next-step`
 * (contract: reports/day_2026-09-27/next-step-contract.md) — the console's
 * Overview reads the same answer. `planNextStep` below is the same rule table,
 * used only while the backend doesn't serve the endpoint yet (404) or the
 * account isn't reachable from this interface. Remove it once every backend
 * Work talks to has the endpoint.
 *
 * Pure: no React, no fetch.
 */
import type { GoalId } from "../../setup/goals";
import { parseGoal } from "../../setup/goals";

export const NEXT_STEP_IDS = [
  "pick_goal",
  "connect_agent",
  "agent_publish_site",
  "agent_gets_computer",
  "describe_site",
  "site_add_form",
  "get_computer",
  "describe_bot",
  "bot_save_orders",
  "get_ai_hours",
  "talk_to_uno",
  "connect_telegram",
  "morning_plan",
  "create_computer",
  "connect_ssh",
  "install_app",
] as const;
export type KnownNextStepId = (typeof NEXT_STEP_IDS)[number];

export type NextStepStage = "start" | "first_result" | "growing";
export type GoalSource = "console" | "guessed" | "none";

export interface NextStepSignals {
  /** Uno AI hours left (or unlimited), or the person's own model by default. */
  readonly aiAvailable: boolean;
  readonly aiHoursLeftMinutes: number | null;
  readonly ownAi: boolean;
  readonly hasPlan: boolean;
  readonly plan: string | null;
  readonly computers: number;
  readonly hasWorkComputer: boolean;
  readonly sites: number;
  /** A site has form delivery set up (email / Telegram / webhook). Null = not known. */
  readonly formsConfigured: boolean | null;
  readonly agentKeyCreated: boolean;
  /** The agent's key was used at least once. */
  readonly agentConnected: boolean;
  readonly telegramLinked: boolean;
  readonly sshKeys: number;
  /** The goal's first result (funnel `first_result`), when known. */
  readonly firstResultGoal: GoalId | null;
  /** Ideas the person already took or closed (morning plan, orders table…). */
  readonly ideasDone: ReadonlyArray<string>;
}

export interface NextStepItem {
  /** One of NEXT_STEP_IDS; an unknown id from a newer backend still renders (title + console). */
  readonly id: string;
  readonly title: string;
  readonly hint: string | null;
  readonly done: boolean;
  /** Where the console does it (relative path on console.uno4.dev). */
  readonly consolePath: string | null;
}

export interface NextStepPlan {
  readonly goal: GoalId | null;
  readonly goalSource: GoalSource;
  readonly stage: NextStepStage;
  readonly next: NextStepItem | null;
  readonly steps: ReadonlyArray<NextStepItem>;
  readonly aiAvailable: boolean;
  /** "backend" — the account's answer; "local" — the fallback below. */
  readonly source: "backend" | "local";
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

/** No goal picked anywhere: what the account has says it. */
export function guessGoal(signals: NextStepSignals): GoalId | null {
  if (signals.agentKeyCreated) return "own_agent";
  if (signals.sites > 0) return "site";
  if (signals.hasWorkComputer) return "assistant";
  if (signals.computers > 0) return "server";
  return null;
}

const step = (
  id: KnownNextStepId,
  title: string,
  hint: string | null,
  consolePath: string | null,
  done: boolean,
): NextStepItem => ({ id, title, hint, consolePath, done });

/** The goal's checklist, in order. Same table as the backend's. */
export function goalSteps(goal: GoalId | null, s: NextStepSignals): NextStepItem[] {
  const idea = (id: string) => s.ideasDone.includes(id);
  switch (goal) {
    case "own_agent":
      return [
        step(
          "connect_agent",
          "Connect your Claude Code or Codex",
          "Paste one block into your agent. It gets its own key.",
          "/access?give=agent",
          s.agentConnected,
        ),
        step(
          "agent_publish_site",
          "Ask your agent to publish a site",
          "“Publish this folder on Uno and send me the link.”",
          "/access?give=agent",
          s.sites > 0,
        ),
        step(
          "agent_gets_computer",
          "Give your agent a computer",
          "For bots and anything that runs 24/7.",
          "/billing?tab=plan",
          s.computers > 0,
        ),
      ];
    case "site":
      return [
        step(
          "describe_site",
          "Describe your site",
          "Or drop a folder. You get a live link.",
          "/start?path=host&step=setup",
          s.sites > 0,
        ),
        step(
          "site_add_form",
          "Add a sign-up form",
          "Answers come to your Telegram.",
          "/sites",
          s.formsConfigured === true || idea("site_add_form"),
        ),
      ];
    case "bot": {
      const list: NextStepItem[] = [];
      // A plan only where it's needed: the bot runs 24/7 on a computer.
      if (s.computers === 0) {
        list.push(
          step(
            "get_computer",
            "Get a computer for your bot",
            "A bot runs 24/7. From Small, $5 a month.",
            "/billing?tab=plan",
            false,
          ),
        );
      }
      list.push(
        step(
          "describe_bot",
          "Tell Uno what your bot does",
          "Uno builds it and keeps it running.",
          "/start?path=bot",
          s.firstResultGoal === "bot",
        ),
        step(
          "bot_save_orders",
          "Save every order to a table you own",
          "And a short summary every evening.",
          null,
          idea("bot_save_orders"),
        ),
      );
      return list;
    }
    case "assistant": {
      const list: NextStepItem[] = [];
      // No AI → no "talk to Uno" and no Telegram: they'd answer "out of credits".
      if (!s.aiAvailable) {
        list.push(
          step(
            "get_ai_hours",
            "Turn on AI for your assistant",
            "Add Uno AI hours or use your own ChatGPT or Claude subscription.",
            "/billing?tab=plan",
            false,
          ),
        );
      }
      list.push(
        step(
          "talk_to_uno",
          "Talk to Uno",
          "Ask it anything. It can use this computer.",
          null,
          s.firstResultGoal === "assistant",
        ),
        step(
          "connect_telegram",
          "Write to Uno in Telegram",
          "It answers day and night, even when your laptop is closed.",
          null,
          s.telegramLinked,
        ),
        step(
          "morning_plan",
          "Get a short plan for your day every morning",
          "In Telegram, at 9.",
          null,
          idea("morning_plan"),
        ),
      );
      return list;
    }
    case "server":
      return [
        step(
          "create_computer",
          "Start your server",
          "A clean Linux computer, always on.",
          "/start?path=computer&step=setup",
          s.computers > 0,
        ),
        step(
          "connect_ssh",
          "Connect with SSH or your agent",
          "Add your SSH key or give your agent a key.",
          "/access",
          s.sshKeys > 0 || s.agentConnected,
        ),
        step(
          "install_app",
          "Put your first app on it",
          "Tell Uno what to run.",
          null,
          idea("install_app"),
        ),
      ];
    default:
      return [
        step(
          "pick_goal",
          "What do you want to do?",
          "A website, a Telegram bot, your assistant, your own agent or a server.",
          "/start",
          false,
        ),
      ];
  }
}

export function planNextStep(
  input: { readonly goal: GoalId | null; readonly goalSource: GoalSource },
  signals: NextStepSignals,
): NextStepPlan {
  let goal = input.goal;
  let goalSource = input.goalSource;
  if (goal === null) {
    goal = guessGoal(signals);
    goalSource = goal ? "guessed" : "none";
  }
  const steps = goalSteps(goal, signals);
  const next = steps.find((entry) => !entry.done) ?? null;
  return {
    goal,
    goalSource,
    stage: stageOf(steps, next),
    next,
    steps,
    aiAvailable: signals.aiAvailable,
    source: "local",
  };
}

function stageOf(steps: ReadonlyArray<NextStepItem>, next: NextStepItem | null): NextStepStage {
  if (next === null) return "growing";
  return steps[0]?.done || steps.indexOf(next) > 0 ? "first_result" : "start";
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

/** Uno AI can answer: hours left, unlimited, or the status can't tell (no hours pool). */
export function aiAvailableFrom(
  status: {
    readonly status: string;
    readonly hoursLeftMinutes: number | null;
    readonly unlimited: boolean;
  } | null,
): boolean {
  if (!status || status.status !== "ok") return true;
  if (status.unlimited) return true;
  return status.hoursLeftMinutes === null || status.hoursLeftMinutes > 0;
}

// ── what Home shows ─────────────────────────────────────────────────

/** Answers in settings.setup: a step taken here (ideas) or put off with "Not now". */
export const nextStepDoneKey = (id: string) => `next_done:${id}`;
export const nextStepSkipKey = (id: string) => `next_skip:${id}`;

/**
 * The first step not done on the account and not taken here. "Not now" on it
 * hides the card (Home goes back to normal) — it never jumps ahead to a step
 * that needs this one done first.
 */
export function visibleNextStep(
  plan: NextStepPlan | null,
  answers: Readonly<Record<string, string>>,
): NextStepItem | null {
  if (!plan) return null;
  const list = plan.steps.length > 0 ? plan.steps : plan.next ? [plan.next] : [];
  const first = list.find((entry) => !entry.done && !answers[nextStepDoneKey(entry.id)]);
  return first && !answers[nextStepSkipKey(first.id)] ? first : null;
}
