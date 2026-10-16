/**
 * "Put my AI agent on a server" (flow-agent 15.10, Misha): the person's own
 * agent — Claude Code or Codex — runs on this computer in Uno Work. It signs in
 * with the CLI's own link (`claude auth login` / `codex login --device-auth`,
 * the in-app sign-in dialog), never a page of ours. After that, Home's Next
 * step card leads through the screens Work already has, one at a time:
 * project → skills → tools → Telegram/Slack → first task.
 *
 * The backend owns the order (fishcode nextstep `agentOnServerSteps`); this is
 * what Work knows on top of it — what is already done on this computer, which
 * agent the person picked, and whether the sign-in should open by itself.
 *
 * Pure: no React, no fetch.
 */
import type { ProviderAuthDriver, ServerProvider, UnoSetupProgress } from "@t3tools/contracts";

import type { SetupStepId } from "../../setup/setupModel";

/** The backend's step ids of the agent-on-a-server checklist. */
export const AGENT_START_STEP = {
  connectAgent: "connect_agent",
  addProject: "add_project",
  addSkills: "add_skills",
  connectTools: "connect_tools",
  connectChannel: "connect_channel",
  firstTask: "first_task",
} as const;

/**
 * Not a step: the funnel mark (`next_step_clicked` with this `step_id`) that
 * tells the account the agent signed in here — it closes `connect_agent` for
 * the console too (fishcode `StepAgentSignedIn`).
 */
export const AGENT_SIGNED_IN_MARK = "agent_signed_in";

/** Next-step ids that are one existing setup step, opened on its own. */
export const NEXT_STEP_SETUP_STEP: Readonly<Record<string, SetupStepId>> = {
  [AGENT_START_STEP.addSkills]: "skills",
  [AGENT_START_STEP.connectTools]: "connectors",
  [AGENT_START_STEP.connectChannel]: "channels",
};

/** The next-step id a setup step stands for when the card opened it (`one=1`). */
export function nextStepIdForSetupStep(step: SetupStepId): string | null {
  for (const [id, setupStep] of Object.entries(NEXT_STEP_SETUP_STEP)) {
    if (setupStep === step) return id;
  }
  return null;
}

/** settings.setup.answers: the agent picked before Work (the landing's "Which AI will you use?"). */
export const AGENT_PICK_KEY = "own_agent_harness";
/** settings.setup.answers: the sign-in already opened by itself once on this computer. */
export const AGENT_SIGN_IN_PROMPTED_KEY = "own_agent_sign_in_prompted";
/** settings.setup.answers: the account was told the agent signed in (`agent_signed_in`). */
export const AGENT_SIGNED_IN_SENT_KEY = "own_agent_signed_in_sent";

/** `?agent=` of the entry link, or an answer saved earlier → the harness it means. */
export function parseAgentDriver(value: unknown): ProviderAuthDriver | null {
  switch (typeof value === "string" ? value.trim().toLowerCase() : null) {
    case "claude":
    case "claudeagent":
    case "claude-code":
      return "claudeAgent";
    case "codex":
      return "codex";
    default:
      return null;
  }
}

/** Account `default_ai` (picked in the console) → a harness with a CLI sign-in. */
export function agentDriverFromAccountDefault(value: unknown): ProviderAuthDriver | null {
  return value === "claude" ? "claudeAgent" : value === "codex" ? "codex" : null;
}

export const AGENT_LABEL: Readonly<Record<ProviderAuthDriver, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
};

/**
 * Signed in with the person's own account or key. Claude Code without a
 * sign-in of its own runs on the plan's Uno AI credit (`auth.type` "unoAi") —
 * that is not "their agent signed in".
 */
export function signedInWithOwnAccount(provider: ServerProvider | undefined | null): boolean {
  return (
    !!provider &&
    provider.installed &&
    provider.auth.status === "authenticated" &&
    provider.auth.type !== "unoAi"
  );
}

/**
 * Which agent this person means: the entry link's `?agent=`, then the one
 * saved on this computer, then the account's default AI; Claude Code when
 * nothing says (the landing's default).
 */
export function pickAgentDriver(input: {
  readonly arrived: ProviderAuthDriver | null;
  readonly saved: ProviderAuthDriver | null;
  readonly accountDefault: ProviderAuthDriver | null;
}): ProviderAuthDriver {
  return input.arrived ?? input.saved ?? input.accountDefault ?? "claudeAgent";
}

/**
 * The sign-in opens by itself once — on the first visit after the person
 * picked their agent before Work (`?agent=`, or an own-agent goal with the
 * account's default AI set to Claude or Codex) — and only while that agent
 * is installed here and not signed in yet.
 */
export function shouldAutoOpenAgentSignIn(input: {
  readonly lite: boolean;
  readonly arrived: ProviderAuthDriver | null;
  readonly ownAgentGoal: boolean;
  readonly accountDefault: ProviderAuthDriver | null;
  readonly prompted: boolean;
  readonly provider: ServerProvider | undefined | null;
}): boolean {
  if (input.lite || input.prompted) return false;
  if (!input.arrived && !(input.ownAgentGoal && input.accountDefault)) return false;
  // No snapshot yet, or not installed: the install UI owns that.
  if (!input.provider || !input.provider.installed) return false;
  return !signedInWithOwnAccount(input.provider);
}

/**
 * Steps of the agent-on-a-server checklist already done on this computer,
 * before the account catches up (or where it never sees it):
 * - connect_agent — Claude Code or Codex signed in with the person's account;
 * - add_project — the setup made or picked a project;
 * - add_skills / connect_tools / connect_channel — that setup step was
 *   finished (Continue, not Skip), here or in Settings → Full setup;
 * - connect_channel — also Telegram or Slack already on for Uno here.
 */
export function agentStartDoneHere(input: {
  readonly agentSignedIn: boolean;
  readonly progress: UnoSetupProgress;
  readonly channelOn: boolean;
}): ReadonlySet<string> {
  const { progress } = input;
  const finished = (step: SetupStepId) =>
    progress.visited.includes(step) && !progress.skipped.includes(step);
  const done = new Set<string>();
  if (input.agentSignedIn) done.add(AGENT_START_STEP.connectAgent);
  if (progress.project) done.add(AGENT_START_STEP.addProject);
  for (const [id, step] of Object.entries(NEXT_STEP_SETUP_STEP)) {
    if (finished(step)) done.add(id);
  }
  if (input.channelOn) done.add(AGENT_START_STEP.connectChannel);
  return done;
}

/** "Give it a first task": typed into a new chat, not sent — the person makes it theirs. */
export const AGENT_FIRST_TASK_PROMPT =
  "Look at my project and tell me three things you can do in it while I'm away. Then start on the first one.";
