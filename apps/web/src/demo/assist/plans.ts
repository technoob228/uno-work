/**
 * `plans=full` (T3 port 30.10): the person's own AI plans across computers.
 * uno-work (the page's computer) is signed in to Claude Max 5x — at its
 * 5-hour limit; the MacBook to another Claude account (Pro, with room) and to
 * ChatGPT Plus. One chat on uno-work stopped at the limit (Claude Code's own
 * stop line as its last reply). Data goes through the daemon's real route
 * (`uno.computer.planLimits`) and provider snapshots, like on a real computer.
 */
import type { PlanLimits } from "@t3tools/contracts";

import { WORLD } from "./world";

export const DEMO_PLANS = WORLD.plans === "full";

const NOW = Date.now();
const later = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** Machines with a plan of their own (by demo machine key). */
export function hasPlans(machineKey: string): boolean {
  return DEMO_PLANS && (machineKey === "work" || machineKey === "mac");
}

export function planLimitsFor(machineKey: string): PlanLimits {
  if (!DEMO_PLANS) return { accounts: [] };
  if (machineKey === "work") {
    return {
      accounts: [
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
  if (machineKey !== "mac") return [claude];
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
