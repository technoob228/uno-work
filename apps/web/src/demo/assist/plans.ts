/**
 * `plans=full` (T3 port 30.10): the person's own AI plans across computers.
 * uno-work (the page's computer) is signed in to Claude Max 5x — at its
 * 5-hour limit; the MacBook to another Claude account (Pro, with room) and to
 * ChatGPT Plus. One chat on uno-work stopped at the limit (Claude Code's own
 * stop line as its last reply). Data goes through the daemon's real route
 * (`uno.computer.planLimits`) and provider snapshots, like on a real computer.
 */
import type { PlanLimits, PlanLimitsAccount } from "@t3tools/contracts";
import {
  PLAN_RESUME_ENDED_ACTIVITY,
  PLAN_RESUME_SCHEDULED_ACTIVITY,
} from "@t3tools/shared/planLimitRules";

import { WORLD } from "./world";

/** `plans=accounts`: the daemon that waits for the reset and takes a second account. */
export const DEMO_ACCOUNTS = WORLD.plans === "accounts";
export const DEMO_PLANS = WORLD.plans === "full" || DEMO_ACCOUNTS;

const NOW = Date.now();
const later = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** Machines with a plan of their own (by demo machine key). */
export function hasPlans(machineKey: string): boolean {
  return DEMO_PLANS && (machineKey === "work" || machineKey === "mac");
}

// ── plans=accounts: what a real daemon keeps in settings and sign-in folders ──

interface DemoSecondAccount {
  readonly instanceId: string;
  readonly driver: "claudeAgent" | "codex";
  readonly displayName: string;
  signedIn: boolean;
}

const secondAccounts: DemoSecondAccount[] = [];
const demoSettings = { multipleAccounts: false, resumeAfterPlanLimit: true };
let demoProviderInstances: Record<string, unknown> = {};
let accountCounter = 0;

export const demoPlanSettings = () =>
  DEMO_ACCOUNTS ? { ...demoSettings, providerInstances: demoProviderInstances } : {};

export function applyDemoPlanSettings(patch: Record<string, unknown>) {
  if (typeof patch.multipleAccounts === "boolean") {
    demoSettings.multipleAccounts = patch.multipleAccounts;
  }
  if (typeof patch.resumeAfterPlanLimit === "boolean") {
    demoSettings.resumeAfterPlanLimit = patch.resumeAfterPlanLimit;
  }
  if (patch.providerInstances && typeof patch.providerInstances === "object") {
    demoProviderInstances = patch.providerInstances as Record<string, unknown>;
  }
}

export function addDemoAccount(driver: "claudeAgent" | "codex", name: string) {
  accountCounter += 1;
  const instanceId = `${driver}_account_demo${accountCounter}`;
  const displayName = `${driver === "codex" ? "ChatGPT" : "Claude"} · ${name}`;
  secondAccounts.push({ instanceId, driver, displayName, signedIn: false });
  demoProviderInstances = {
    ...demoProviderInstances,
    [instanceId]: { driver, displayName, enabled: true },
  };
  return { instanceId, displayName };
}

export function removeDemoAccount(instanceId: string) {
  const index = secondAccounts.findIndex((account) => account.instanceId === instanceId);
  if (index >= 0) secondAccounts.splice(index, 1);
  const { [instanceId]: _gone, ...rest } = demoProviderInstances;
  demoProviderInstances = rest;
  return { instanceId, removed: index >= 0 };
}

/** A sign-in the demo finishes by itself on the second look: no browser here. */
const demoAuthJobs = new Map<
  string,
  { instanceId: string | null; driver: string; polls: number }
>();

export function startDemoAuth(input: {
  readonly driver: string;
  readonly instanceId?: string;
}): string {
  const jobId = `demo-auth-${demoAuthJobs.size + 1}`;
  demoAuthJobs.set(jobId, {
    instanceId: input.instanceId ?? null,
    driver: input.driver,
    polls: 0,
  });
  return jobId;
}

/** `done`: this poll is the one that signed the account in. */
export function pollDemoAuth(jobId: string) {
  const job = demoAuthJobs.get(jobId);
  const base = {
    jobId,
    driver: job?.driver ?? "claudeAgent",
    method: "oauth",
    log: "",
    needsCodeInput: false,
  };
  if (!job) return { status: { ...base, state: "failed", error: "Unknown job" }, done: false };
  job.polls += 1;
  if (job.polls < 3) {
    return {
      status: {
        ...base,
        state: "running",
        verificationUrl: "https://claude.ai/oauth/authorize?demo",
      },
      done: false,
    };
  }
  const account = secondAccounts.find((entry) => entry.instanceId === job.instanceId);
  const done = account !== undefined && !account.signedIn;
  if (account) account.signedIn = true;
  return { status: { ...base, state: "succeeded" }, done };
}

const secondAccountRows = (): PlanLimitsAccount[] =>
  secondAccounts
    .filter((account) => account.signedIn)
    .map((account) => ({
      id: `${account.driver === "codex" ? "chatgpt" : "claude"}:personal@getuno.xyz`,
      instanceId: account.instanceId,
      provider: account.driver === "codex" ? "chatgpt" : "claude",
      plan: "Pro",
      email: "personal@getuno.xyz",
      checkedAt: ago(1),
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "5-hour",
          usedPercent: 18,
          resetsAt: later(210),
          windowDurationMins: 300,
        },
      ],
    }));

export function secondAccountProviders(machineKey: string, base: Record<string, unknown>) {
  if (!DEMO_ACCOUNTS || machineKey !== "work") return [];
  return secondAccounts
    .filter((account) => {
      const instance = demoProviderInstances[account.instanceId] as
        | { readonly enabled?: boolean }
        | undefined;
      return instance?.enabled !== false;
    })
    .map((account) => ({
      ...base,
      driver: account.driver,
      instanceId: account.instanceId,
      displayName: account.displayName,
      continuation: { groupKey: `claude:config:${account.instanceId}` },
      auth: account.signedIn
        ? {
            status: "authenticated",
            type: "claude.ai",
            label: "Pro",
            email: "personal@getuno.xyz",
          }
        : { status: "unauthenticated" },
    }));
}

/** The stopped chat waits for the plan: what the daemon appends when the turn ends. */
export const planResumeActivity = () => ({
  id: "plan-limit-signup-resume",
  tone: "info",
  kind: PLAN_RESUME_SCHEDULED_ACTIVITY,
  summary: "Resumes after the plan's limit",
  payload: { resumeAt: later(135), source: "plan" },
  turnId: null,
  createdAt: ago(5),
});

export const planResumeEndedActivity = () => ({
  id: `plan-limit-signup-resume-ended-${Date.now()}`,
  tone: "info",
  kind: PLAN_RESUME_ENDED_ACTIVITY,
  summary: "Won't resume by itself",
  payload: { reason: "person-cancelled" },
  turnId: null,
  createdAt: new Date().toISOString(),
});

export function planLimitsFor(machineKey: string): PlanLimits {
  if (!DEMO_PLANS) return { accounts: [] };
  if (machineKey === "work") {
    return {
      accounts: [
        ...secondAccountRows(),
        {
          id: "claude:misha@getuno.xyz",
          provider: "claude",
          plan: "Max 5x",
          email: "misha@getuno.xyz",
          checkedAt: ago(1),
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "5-hour",
              usedPercent: 100,
              resetsAt: later(134),
              windowDurationMins: 300,
            },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 64,
              resetsAt: later(60 * 24 * 3 + 40),
            },
          ],
        },
      ],
    };
  }
  if (machineKey === "mac") {
    return {
      accounts: [
        {
          id: "claude:misha.work@studio.io",
          provider: "claude",
          plan: "Pro",
          email: "misha.work@studio.io",
          checkedAt: ago(3),
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "5-hour",
              usedPercent: 35,
              resetsAt: later(200),
              windowDurationMins: 300,
            },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 22,
              resetsAt: later(60 * 24 * 5),
            },
          ],
        },
        {
          id: "chatgpt:misha@getuno.xyz",
          provider: "chatgpt",
          plan: "Plus",
          email: "misha@getuno.xyz",
          checkedAt: ago(3),
          windows: [
            {
              id: "primary",
              kind: "session",
              label: "5-hour",
              usedPercent: 12,
              resetsAt: later(260),
              windowDurationMins: 300,
            },
          ],
        },
      ],
    };
  }
  return { accounts: [] };
}

/** Claude Code (and Codex on the MacBook) signed in with the person's own accounts. */
export function planProvidersFor(machineKey: string, checkedAt: string, version: string) {
  if (!hasPlans(machineKey)) return [];
  const claude = {
    driver: "claudeAgent",
    instanceId: "claudeAgent",
    displayName: "Claude",
    enabled: true,
    installed: true,
    version,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "claude.ai",
      label: machineKey === "work" ? "Max 5x" : "Pro",
      email: machineKey === "work" ? "misha@getuno.xyz" : "misha.work@studio.io",
    },
    checkedAt,
    models: [
      { slug: "claude-sonnet-5", name: "Sonnet 5", isCustom: false, capabilities: null },
      { slug: "claude-opus-5", name: "Opus 5", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  };
  if (machineKey !== "mac") return [claude, ...secondAccountProviders(machineKey, claude)];
  return [
    claude,
    {
      ...claude,
      driver: "codex",
      instanceId: "codex",
      displayName: "Codex",
      auth: { status: "authenticated", type: "chatgpt", label: "Plus", email: "misha@getuno.xyz" },
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
    },
  ];
}

/** The chat that stopped at the limit (uno-work, landing project's home). */
export const PLAN_LIMIT_CHAT = {
  id: "plan-limit-signup",
  machine: "work",
  title: "Fix the signup form on the landing",
  minutesAgo: 6,
  state: "unread",
  role: "solo",
  harness: "claude",
  messages: [
    ["user", "The signup form on the landing doesn't send the email field. Fix it and redeploy."],
    [
      "assistant",
      "Found it: the form posts `mail` but the handler reads `email`. Renaming the field now.",
    ],
    ["assistant", "You've hit your limit · resets 3pm (Europe/Moscow)"],
  ],
} as const;
