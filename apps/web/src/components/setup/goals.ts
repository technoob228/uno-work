/**
 * Goal-first start (replaces the eight-step wizard on first launch).
 *
 * Three screens: 1) what do you want to do, 2) how do you work (Uno AI by
 * default, or your own agent), 3) the result. The project is made for the
 * goal (its name comes from the goal), the skills for the goal are installed
 * quietly, and after the first result Home offers one next step beyond the
 * ready scenario. The eight steps still exist: Settings → "Full setup".
 *
 * Pure part only: copy, ids, prompts. Progress is kept in
 * `settings.setup.answers` (plain strings, so an older daemon round-trips it).
 */
import type { UnoSetupProgress } from "@t3tools/contracts";

import type { SetupSkillId } from "./setupSkills";

export const GOALS = ["assistant", "site", "bot", "own_agent", "server"] as const;
export type GoalId = (typeof GOALS)[number];

/** How the work gets done: Uno AI, the person's subscription here, or their agent elsewhere. */
export const CONNECT_PATHS = ["uno_ai", "own_subscription", "own_agent", "ssh"] as const;
export type ConnectPath = (typeof CONNECT_PATHS)[number];

export function parseGoal(value: unknown): GoalId | null {
  return typeof value === "string" && (GOALS as ReadonlyArray<string>).includes(value)
    ? (value as GoalId)
    : null;
}

export function parseConnectPath(value: unknown): ConnectPath | null {
  return typeof value === "string" && (CONNECT_PATHS as ReadonlyArray<string>).includes(value)
    ? (value as ConnectPath)
    : null;
}

export interface GoalCopy {
  readonly id: GoalId;
  readonly title: string;
  readonly sub: string;
  /** Home's goal buttons (short). */
  readonly button: string;
}

export const GOAL_COPY: Readonly<Record<GoalId, GoalCopy>> = {
  assistant: {
    id: "assistant",
    title: "My assistant",
    sub: "It's already on. Write to it in Telegram.",
    button: "My assistant",
  },
  site: {
    id: "site",
    title: "A website",
    sub: "Drop a folder or describe it. Get a live link.",
    button: "A website",
  },
  bot: {
    id: "bot",
    title: "A Telegram bot",
    sub: "Tell Uno what the bot does. It runs 24/7.",
    button: "A Telegram bot",
  },
  own_agent: {
    id: "own_agent",
    title: "I have my own agent",
    sub: "Claude Code, Codex or Cursor. One line to paste.",
    button: "My own agent",
  },
  server: {
    id: "server",
    title: "Just a server",
    sub: "A clean Linux computer. SSH and a terminal.",
    button: "Just a server",
  },
};

/** Goals that ask "how do you work?" (the other two are that answer already). */
export function goalAsksHow(goal: GoalId): boolean {
  return goal === "assistant" || goal === "site" || goal === "bot";
}

/** The connect path a goal implies when it skips the "how" screen. */
export function impliedConnectPath(goal: GoalId): ConnectPath | null {
  if (goal === "own_agent") return "own_agent";
  if (goal === "server") return "ssh";
  return null;
}

/** The goal's project: made for it, named after it. The assistant has its own. */
export const GOAL_PROJECT: Readonly<
  Partial<Record<GoalId, { name: string; slug: string; kind: string }>>
> = {
  site: { name: "My website", slug: "my-website", kind: "site" },
  bot: { name: "Telegram bot", slug: "telegram-bot", kind: "bot" },
};

/** Skills installed quietly for the goal (no skills screen on first run). */
export const GOAL_SKILLS: Readonly<Record<GoalId, ReadonlyArray<SetupSkillId>>> = {
  assistant: ["sales-copy", "up-to-date-docs"],
  site: ["impeccable", "sales-copy", "up-to-date-docs"],
  bot: ["server-safety", "up-to-date-docs"],
  own_agent: ["server-safety"],
  server: ["server-safety"],
};

/** AGENTS.md for the goal's project: plain words, one next step after the result. */
export function goalAgentsMd(goal: GoalId, projectName: string): string {
  const lines = [`# AGENTS.md — ${projectName}`, ""];
  if (goal === "site") {
    lines.push(
      "## This project",
      "A website for the person. Publish it on Uno Hosting with `site_publish` and send the live link.",
      "",
      "## How to work",
      "- If you don't know what the site is about, ask 3–5 short questions first (who it's for, what they offer, how people get in touch). Write the texts from the answers: short, concrete, no filler.",
      "- Show the result, not the code. Plain words.",
    );
  } else if (goal === "bot") {
    lines.push(
      "## This project",
      "A Telegram bot for the person. The bot token is in `.env` as `TELEGRAM_BOT_TOKEN`. Never print it.",
      "",
      "## How to work",
      "- Build the bot here, run it with `app_register` so it keeps running 24/7, test it, then tell the person to write to the bot.",
      "- Ask only what you need. Plain words. Show the result, not the code.",
    );
  } else {
    lines.push("## How to work", "- Plain words. Show the result, not the code.");
  }
  lines.push(
    "",
    "## After the first result",
    "When the first result works, suggest ONE concrete next step that goes beyond it — something the person can own instead of paying for someone else's software (a form that sends answers to Telegram, a table for orders, their own tracker instead of Jira). One idea, one sentence, ask if they want it.",
    "",
  );
  return lines.join("\n");
}

/** The first task sent to Uno for goals it builds. */
export function goalFirstPrompt(
  goal: GoalId,
  input: { readonly description?: string; readonly folder?: string },
): string {
  const what = input.description?.trim();
  if (goal === "site") {
    if (input.folder) {
      return `The files in ${input.folder} should be my website. Make them work as a site (add an index.html if it's missing), publish it on Uno Hosting and send me the link.`;
    }
    return `Make me a one-page website: ${what || "ask me 3 short questions about it first"}. Publish it on Uno Hosting and send me the link.`;
  }
  if (goal === "bot") {
    return `Make my Telegram bot: ${what || "ask me what it should do"}. The bot token is already in .env as TELEGRAM_BOT_TOKEN. Keep the bot running 24/7 on this computer, test it, then tell me to write to it.`;
  }
  return what ?? "";
}

export interface NextStepIdea {
  readonly title: string;
  readonly prompt: string;
}

/** One idea beyond the ready scenario, shown after the first result. */
export const NEXT_STEP: Readonly<Record<GoalId, NextStepIdea>> = {
  assistant: {
    title: "Every morning at 9, get a short plan for your day in Telegram.",
    prompt:
      "Every morning at 9, send me in Telegram a short plan for my day. Ask me what to include first.",
  },
  site: {
    title: "Add a sign-up form. Answers come to your Telegram.",
    prompt:
      "Add a sign-up form to my website. Send every answer to me in Telegram and keep them in a table I can open.",
  },
  bot: {
    title: "Save every order the bot takes to a table you own.",
    prompt:
      "Make my bot save every order to a table on this computer that I can open and download, and send me a short summary every evening.",
  },
  own_agent: {
    title: "Let your agent keep working here when your laptop is closed.",
    prompt: "",
  },
  server: {
    title: "Put your first app on it: tell Uno what to run.",
    prompt: "Help me run my first app on this server. Ask me what it is.",
  },
};

// ── progress in settings.setup.answers ──────────────────────────────

export const GOAL_KEY = "goal";
export const GOAL_AT_KEY = "goal_at";
export const GOAL_PATH_KEY = "goal_path";
export const GOAL_PROJECT_KEY = "goal_project";
export const FIRST_RESULT_KEY = "first_result_at";
export const FIRST_RESULT_GOAL_KEY = "first_result_goal";
export const NEXT_STEP_KEY = "next_step";
export const BUILT_OWN_KEY = "built_own_at";

export interface GoalState {
  readonly goal: GoalId | null;
  readonly goalAt: string | null;
  readonly path: ConnectPath | null;
  /** Folder of the goal's project, when it has one. */
  readonly projectPath: string | null;
  readonly firstResultAt: string | null;
  /** The goal the first result was for (the next step follows it). */
  readonly firstResultGoal: GoalId | null;
  /** "shown" | "clicked" | "closed" */
  readonly nextStep: string | null;
  readonly builtOwnAt: string | null;
}

export function goalState(progress: UnoSetupProgress): GoalState {
  const answers = progress.answers ?? {};
  return {
    goal: parseGoal(answers[GOAL_KEY]),
    goalAt: answers[GOAL_AT_KEY] || null,
    path: parseConnectPath(answers[GOAL_PATH_KEY]),
    projectPath: answers[GOAL_PROJECT_KEY] || null,
    firstResultAt: answers[FIRST_RESULT_KEY] || null,
    firstResultGoal: parseGoal(answers[FIRST_RESULT_GOAL_KEY]),
    nextStep: answers[NEXT_STEP_KEY] || null,
    builtOwnAt: answers[BUILT_OWN_KEY] || null,
  };
}

/**
 * Picking a goal finishes onboarding: the sidebar's "Set up N/8" row goes
 * away (the eight steps stay reachable from Settings).
 */
export function withGoal(progress: UnoSetupProgress, goal: GoalId): UnoSetupProgress {
  return {
    ...progress,
    mode: "ai",
    finished: true,
    dismissed: true,
    answers: {
      ...progress.answers,
      [GOAL_KEY]: goal,
      // The first pick starts the clock for "sign-up → first result".
      [GOAL_AT_KEY]: progress.answers[GOAL_AT_KEY] || new Date().toISOString(),
    },
  };
}

export function withAnswer(
  progress: UnoSetupProgress,
  key: string,
  value: string,
): UnoSetupProgress {
  if (progress.answers[key] === value) return progress;
  return { ...progress, answers: { ...progress.answers, [key]: value } };
}

/** A zip or a folder whose files share one top folder: that folder is the site. */
export function stripSharedTopFolder<T extends { readonly relativePath: string }>(
  files: ReadonlyArray<T>,
  rename: (file: T, relativePath: string) => T,
): T[] {
  const visible = files.filter((file) => !isJunkPath(file.relativePath));
  if (visible.length === 0) return [];
  const first = visible[0]!.relativePath.split("/")[0];
  const shared =
    first !== undefined &&
    visible.every(
      (file) => file.relativePath.includes("/") && file.relativePath.split("/")[0] === first,
    );
  if (!shared) return visible;
  return visible.map((file) => rename(file, file.relativePath.slice(first!.length + 1)));
}

export function isJunkPath(path: string): boolean {
  return path
    .split("/")
    .some((part) => part === "__MACOSX" || part === ".DS_Store" || part === ".git");
}

export function hasIndexHtml(files: ReadonlyArray<{ readonly relativePath: string }>): boolean {
  return files.some((file) => file.relativePath.toLowerCase() === "index.html");
}

/** A site name from the folder / zip name: lowercase, dashes, ≤30 chars. */
export function siteSlugFrom(name: string): string {
  const base = name
    .replace(/\.zip$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 22);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base || "site"}-${suffix}`.slice(0, 30);
}

// ── what counts as a result (Home watches for it) ───────────────────

export interface ResultSignals {
  /** Sites on Uno Hosting with their last publish time. */
  readonly sites: ReadonlyArray<{ readonly updatedAt: string | null }>;
  /** Apps registered on this computer: their folder and state. */
  readonly apps: ReadonlyArray<{
    readonly codeDir?: string | null | undefined;
    readonly status: string;
  }>;
}

/**
 * The first result of a goal Uno builds in a chat: a site published after
 * the goal was picked; a bot running from the goal's folder. Null = not yet.
 */
export function detectFirstResult(state: GoalState, signals: ResultSignals): string | null {
  if (state.firstResultAt || !state.goal) return null;
  if (state.goal === "site") {
    const since = state.goalAt ? Date.parse(state.goalAt) : 0;
    const site = signals.sites.find(
      (entry) => entry.updatedAt !== null && Date.parse(entry.updatedAt) >= since,
    );
    return site ? "chat" : null;
  }
  if (state.goal === "bot" && state.projectPath) {
    const base = state.projectPath.replace(/\/+$/, "");
    const app = signals.apps.find(
      (entry) =>
        entry.status === "running" &&
        typeof entry.codeDir === "string" &&
        (entry.codeDir === base || entry.codeDir.startsWith(`${base}/`)),
    );
    return app ? "app" : null;
  }
  return null;
}

/**
 * "Built something of their own": after the first result, a chat started
 * later (not the assistant) finished a turn — work beyond the ready scenario.
 */
export function detectBuiltOwn(
  state: GoalState,
  threads: ReadonlyArray<{
    readonly createdAt: string;
    readonly completedAt: string | null;
    readonly isAssistant: boolean;
  }>,
): boolean {
  if (!state.firstResultAt || state.builtOwnAt) return false;
  const since = Date.parse(state.firstResultAt);
  return threads.some(
    (thread) =>
      !thread.isAssistant && thread.completedAt !== null && Date.parse(thread.createdAt) > since,
  );
}

/** Records the first result once (later results don't move it). */
export function withFirstResult(progress: UnoSetupProgress, goal: GoalId): UnoSetupProgress {
  if (progress.answers[FIRST_RESULT_KEY]) return progress;
  return {
    ...progress,
    answers: {
      ...progress.answers,
      [FIRST_RESULT_KEY]: new Date().toISOString(),
      [FIRST_RESULT_GOAL_KEY]: goal,
    },
  };
}
