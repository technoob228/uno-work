/**
 * Uno AI hours in the person's words (spec: fishcode
 * `back/knowledge/ai-hours.md`). Plans with Uno AI give AI hours every month
 * instead of dollar credits; inside them the included models are unlimited,
 * unused hours never expire. Premium models are paid per token from premium
 * credit (`llm_balance`).
 *
 * Every reader here returns null when the console has no AI hours (an older
 * backend, or the flag is off for the account) — callers then keep the dollar
 * credits display. Pure functions, unit-tested.
 */
import type { AccountBalance, AccountPlan, AccountSubscription } from "./accountOverview";

/** Next to every place hours are shown. */
export const AI_HOURS_TIME_NOTE =
  "Time counts only while AI is working. Reading, thinking and typing don't use hours.";

/** 5220 → "87 h", 47 → "47 min", 90 → "1 h 30 min". */
export function formatAiMinutes(minutes: number): string {
  const whole = Math.max(0, Math.floor(minutes));
  if (whole < 60) return `${whole} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  // Past ten hours the minutes are noise.
  return rest === 0 || hours >= 10 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface AiHoursSummary {
  /** Max+AI: no limit. */
  readonly unlimited: boolean;
  /** Minutes left; null for unlimited. */
  readonly leftMinutes: number | null;
  /** Hours the plan adds every month (0 when unknown). */
  readonly monthlyHours: number;
  /** Minutes used today, when the console says. */
  readonly usedTodayMinutes: number | null;
  /** Premium credit + top-ups, for premium models; 0 hides it. */
  readonly premiumUsd: number;
  /** AI power ×N, when known. */
  readonly power: number | null;
}

/**
 * Hours from the subscription first (it knows unlimited and today's use),
 * then `/auth/me` `ai_hours_minutes` (0 there means "no hours" — a Free
 * account keeps its dollar display). Null = no AI hours on this account.
 */
export function aiHoursSummary(input: {
  readonly subscription?: AccountSubscription | null | undefined;
  readonly balance?: AccountBalance | null | undefined;
  /** Today's minutes from `/v1/ai/status`, when the machine has read it. */
  readonly usedTodayMinutes?: number | null | undefined;
}): AiHoursSummary | null {
  const hours = input.subscription?.aiHours ?? null;
  const premiumUsd = Math.max(0, input.balance?.aiBalanceUsd ?? 0);
  const power = input.subscription?.aiPower?.multiplier ?? null;
  const usedToday = hours?.usedTodayMinutes ?? input.usedTodayMinutes ?? null;
  if (hours) {
    return {
      unlimited: hours.unlimited,
      leftMinutes: hours.unlimited ? null : hours.balanceMinutes,
      monthlyHours: hours.monthlyHours,
      usedTodayMinutes: usedToday,
      premiumUsd,
      power,
    };
  }
  const fromMe = input.balance?.aiHoursMinutes ?? null;
  if (fromMe === null || fromMe <= 0) return null;
  return {
    unlimited: false,
    leftMinutes: fromMe,
    monthlyHours: 0,
    usedTodayMinutes: usedToday,
    premiumUsd,
    power,
  };
}

/** "87 h left" / "Unlimited AI". */
export function aiHoursHeadline(summary: AiHoursSummary): string {
  if (summary.unlimited || summary.leftMinutes === null) return "Unlimited AI";
  return `${formatAiMinutes(summary.leftMinutes)} left`;
}

/** "AI hours: 87 h left · never expire" (+ " · $12.40 premium credit"). */
export function aiHoursLine(summary: AiHoursSummary, formatUsd: (usd: number) => string): string {
  const head = summary.unlimited
    ? "Unlimited AI"
    : `AI hours: ${aiHoursHeadline(summary)} · never expire`;
  return summary.premiumUsd > 0
    ? `${head} · ${formatUsd(summary.premiumUsd)} premium credit`
    : head;
}

/** "Today: 47 min", or null when today's use is unknown. */
export function aiHoursTodayLine(summary: AiHoursSummary): string | null {
  return summary.usedTodayMinutes === null
    ? null
    : `Today: ${formatAiMinutes(summary.usedTodayMinutes)}`;
}

/**
 * A plan with Uno AI. Before AI hours that was "has credits"; with hours the
 * cheaper AI plans carry no premium credit, so the `-ai` flavour of a
 * computer (a different slug over the same base) counts too.
 */
export function planHasUnoAi(
  plan: Pick<AccountPlan, "slug" | "baseSlug" | "aiCreditsUsd" | "aiHoursMonthly">,
): boolean {
  if (plan.aiCreditsUsd > 0) return true;
  if (plan.slug !== plan.baseSlug) return true;
  return plan.slug.endsWith("-ai");
}

/** What the plan's Uno AI is, in one line: "40 AI hours a month · AI power ×1". */
export function planAiHoursLine(
  plan: Pick<AccountPlan, "aiHoursMonthly" | "aiHoursUnlimited" | "aiFullSpeedHours" | "aiPower">,
): string | null {
  if (plan.aiHoursUnlimited) {
    const fullSpeed =
      plan.aiFullSpeedHours !== null ? ` · ${plan.aiFullSpeedHours} h a month at full speed` : "";
    return `Unlimited AI${fullSpeed}`;
  }
  if (plan.aiHoursMonthly === null) return null;
  const hours = `${plan.aiHoursMonthly} AI hours a month`;
  return plan.aiPower ? `${hours} · AI power ×${plan.aiPower}` : hours;
}
