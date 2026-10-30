/**
 * When is a person's own AI plan (Claude, ChatGPT) at its limit, and when does
 * it come back? Shared by the daemon (it resumes a stopped chat by itself,
 * with no tab open) and the client (the limit line under a chat, Settings →
 * AI → "Your AI plans"), so both read the same stop line the same way.
 *
 * The words come from the CLIs themselves — a turn that ended on one is what
 * "stopped at the limit" means here. Pure, tested in planLimitRules.test.ts.
 */
import type { PlanLimitsAccount, PlanLimitsWindow } from "@t3tools/contracts";

const HOUR_MS = 60 * 60_000;

export type PlanProvider = PlanLimitsAccount["provider"];

/** The plan a harness runs on when signed in with the person's own account. */
const PLAN_PROVIDER_BY_DRIVER: Readonly<Record<string, PlanProvider>> = {
  claudeAgent: "claude",
  codex: "chatgpt",
};

/** The harness a plan belongs to, the other way round. */
export const DRIVER_BY_PLAN_PROVIDER: Readonly<Record<PlanProvider, string>> = {
  claude: "claudeAgent",
  chatgpt: "codex",
};

/** Null for a harness without a plan of its own (Uno AI, OpenCode, Hermes…). */
export function planProviderForDriver(driver: string | null | undefined): PlanProvider | null {
  return driver ? (PLAN_PROVIDER_BY_DRIVER[driver] ?? null) : null;
}

/** Extra usage (pay-as-you-go spend) isn't a wall: the plan itself still runs. */
export function blocksWork(window: PlanLimitsWindow): boolean {
  return window.id !== "monthly_spend";
}

function resetMs(window: PlanLimitsWindow): number | null {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/** A window whose reset already passed is empty again, whatever the old number says. */
export function usedNow(window: PlanLimitsWindow, now: number): number {
  const at = resetMs(window);
  return at !== null && at <= now ? 0 : window.usedPercent;
}

export interface PlanLimitHit {
  readonly window: PlanLimitsWindow;
  /** When work can go on: the latest reset among the full windows (null: not said). */
  readonly resetsAt: string | null;
}

/**
 * Is this account at its limit now (upstream `exhaustedUsageWindow`)? Every
 * window at 100% that hasn't reset yet; work goes on when the last of them
 * resets — a full weekly window outlasts a full 5-hour one.
 */
export function planAtLimit(account: PlanLimitsAccount, now: number): PlanLimitHit | null {
  const full = account.windows.filter(
    (window) => blocksWork(window) && usedNow(window, now) >= 100,
  );
  if (full.length === 0) return null;
  let latest: PlanLimitsWindow | null = null;
  for (const window of full) {
    const at = resetMs(window);
    if (at === null) continue;
    if (latest === null || at > (resetMs(latest) ?? 0)) latest = window;
  }
  const window = latest ?? full[0]!;
  return { window, resetsAt: latest?.resetsAt ?? null };
}

/**
 * The CLIs' own words when the plan is out (Claude Code: "You've hit your
 * limit · resets 3pm", "5-hour limit reached ∙ resets 3pm", older "Claude AI
 * usage limit reached|<unix>"; Codex: "You've hit your usage limit … try
 * again at 3:05 PM"). Not "approaching the limit" warnings, not the Uno
 * gateway's own "busy" (turnErrorRetry).
 */
const PLAN_LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
  /\busage[ _]limit[ _]reached\b/i,
  /\bhit your (?:\w+[ -])?limit\b/i,
  /\b(?:5-hour|five-hour|session|weekly|opus|sonnet|daily|monthly) limit reached\b/i,
  /\bout of (?:extra )?usage\b/i,
];
const NOT_YET = /\bapproaching\b|\bnearing\b|\bclose to\b/i;

/** Texts this long are an answer that mentions limits, not the CLI's stop line. */
const MAX_LIMIT_LINE = 600;

export function isPlanLimitText(text: string | null | undefined): boolean {
  if (!text || text.length > MAX_LIMIT_LINE) return false;
  if (NOT_YET.test(text)) return false;
  return PLAN_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * When the stop line says work resumes: `|<unix seconds>`, "in 2 hours 5
 * minutes", or "resets 3pm" / "try again at 3:05 PM" (the next such time, in
 * the reader's time zone — the CLI's own zone in brackets is ignored). Null
 * when it doesn't say.
 */
export function planLimitResetFromText(text: string, now: number): string | null {
  const epoch = /\|\s*(\d{10,13})\b/.exec(text);
  if (epoch?.[1]) {
    const raw = Number(epoch[1]);
    const at = raw > 1e12 ? raw : raw * 1000;
    if (at > now) return new Date(at).toISOString();
  }
  const relative = /\b(?:try again|resets?|available again)\s+in\s+([^.;)]+)/i.exec(text);
  if (relative?.[1]) {
    let total = 0;
    for (const match of relative[1].matchAll(
      /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi,
    )) {
      const amount = Number(match[1]);
      const unit = (match[2] ?? "").toLowerCase();
      if (unit.startsWith("d")) total += amount * 24 * HOUR_MS;
      else if (unit.startsWith("h")) total += amount * HOUR_MS;
      else total += amount * 60_000;
    }
    if (total > 0) return new Date(now + total).toISOString();
  }
  const clock =
    /\b(?:resets?|try again at|available again at)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(
      text,
    );
  if (clock?.[1]) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3]!.toLowerCase();
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      const at = new Date(now);
      at.setHours(hour, minute, 0, 0);
      if (at.getTime() <= now) at.setDate(at.getDate() + 1);
      return at.toISOString();
    }
  }
  return null;
}

// ── A stopped chat that goes on by itself ─────────────────────────────

/** Activities the daemon appends to a chat; the client reads the line from them. */
export const PLAN_RESUME_SCHEDULED_ACTIVITY = "plan-limit.resume-scheduled";
export const PLAN_RESUME_ENDED_ACTIVITY = "plan-limit.resume-ended";

/** Message ids of the daemon's own continuation (`plan-resume:<id>`). */
export const PLAN_RESUME_MESSAGE_PREFIX = "plan-resume:";

/** A little after the reset: never ask a second before the provider reopens. */
export const PLAN_RESUME_GRACE_MS = 45_000;
/** Nothing resets later than a week from now; a time past that is a misread. */
export const PLAN_RESUME_MAX_WAIT_MS = 8 * 24 * HOUR_MS;

/** What the person sees and the agent reads when the chat goes on by itself. */
export const PLAN_RESUME_NOTE_BODY =
  "Your plan's limit has reset. Continue where you left off, without repeating finished work.";

/** A second Claude / ChatGPT account on this computer (Settings → AI → "Use more than one account"). */
export const isSecondAccountInstance = (instanceId: string): boolean =>
  /^(claudeAgent|codex)_account_/.test(instanceId);

/** "Continue with <account>": the same chat, on the person's other account. */
export const ACCOUNT_SWITCH_NOTE_BODY =
  "You now run on the person's other account of the same provider. Continue where you left off, without repeating finished work.";

export type PlanResumeTime =
  | { readonly kind: "at"; readonly resumeAt: string; readonly source: "plan" | "text" }
  | { readonly kind: "unknown" }
  | { readonly kind: "too-far" };

/**
 * When a chat stopped by `stopText` should go on. The plan's own numbers win
 * (they know every window); the stop line is used when they are older than
 * the stop. No time said: no guess, a blind try would be the one try wasted.
 */
export function planResumeTime(input: {
  readonly account: PlanLimitsAccount | null;
  readonly stopText: string;
  readonly now: number;
}): PlanResumeTime {
  const hit = input.account ? planAtLimit(input.account, input.now) : null;
  const fromPlan = hit?.resetsAt ?? null;
  const reset = fromPlan ?? planLimitResetFromText(input.stopText, input.now);
  if (reset === null) return { kind: "unknown" };
  const at = Date.parse(reset);
  if (!Number.isFinite(at)) return { kind: "unknown" };
  if (at - input.now > PLAN_RESUME_MAX_WAIT_MS) return { kind: "too-far" };
  return {
    kind: "at",
    resumeAt: new Date(Math.max(at, input.now) + PLAN_RESUME_GRACE_MS).toISOString(),
    source: fromPlan !== null ? "plan" : "text",
  };
}

/**
 * The account a provider instance runs on: a second account's own row, or the
 * computer's main sign-in for the harness's default instance (or none named).
 */
export function planAccountForInstance(
  accounts: ReadonlyArray<PlanLimitsAccount>,
  provider: PlanProvider,
  instanceId: string | null | undefined,
): PlanLimitsAccount | null {
  const same = accounts.filter((account) => account.provider === provider);
  if (instanceId && instanceId !== DRIVER_BY_PLAN_PROVIDER[provider]) {
    return same.find((account) => account.instanceId === instanceId) ?? null;
  }
  return same.find((account) => account.instanceId === undefined) ?? null;
}

/**
 * What the chat's activities say about a waiting continuation: the time of
 * the latest schedule, unless something ended it since. Pure over the
 * activity list so every window of the person agrees.
 */
export function pendingPlanResume(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly payload: unknown;
  }>,
): { readonly resumeAt: string } | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]!;
    if (activity.kind === PLAN_RESUME_ENDED_ACTIVITY) return null;
    if (activity.kind === PLAN_RESUME_SCHEDULED_ACTIVITY) {
      const resumeAt = (activity.payload as { readonly resumeAt?: unknown } | null)?.resumeAt;
      return typeof resumeAt === "string" ? { resumeAt } : null;
    }
  }
  return null;
}
