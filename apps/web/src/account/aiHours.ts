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

/** "AI time" — the unit of Uno AI everywhere (decision 05.10); next to every place it's shown. */
export const AI_TIME_NOTE =
  "Only the minutes the AI is working for you count. Ten chats in the same minute count as one minute.";
/** The older name of the same note. */
export const AI_HOURS_TIME_NOTE = AI_TIME_NOTE;

/** One line for a plan where Fast has no limit (`ai_fast_unlimited`). */
export const AI_FAST_UNLIMITED_LINE = "Uno AI: Fast is unlimited. Smart comes in hours.";

/** The same plan once the Smart hours are gone. */
export const AI_SMART_USED_UP_LINE =
  "Your Smart hours are used up. Fast keeps going at standard speed.";

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
  /** Fast has no limit on this plan; the hours are Smart's. */
  readonly fastUnlimited?: boolean;
  /** The hours are gone and Fast runs at standard speed. */
  readonly fastStandardSpeed?: boolean;
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
  /** `/v1/ai/status` `fast_unlimited` / `fast_standard_speed`, when read. */
  readonly fastUnlimited?: boolean | null | undefined;
  readonly fastStandardSpeed?: boolean | null | undefined;
}): AiHoursSummary | null {
  const hours = input.subscription?.aiHours ?? null;
  const premiumUsd = Math.max(0, input.balance?.aiBalanceUsd ?? 0);
  const power = input.subscription?.aiPower?.multiplier ?? null;
  const usedToday = hours?.usedTodayMinutes ?? input.usedTodayMinutes ?? null;
  const fastUnlimited =
    input.fastUnlimited === true || input.subscription?.limits?.aiFastUnlimited === true;
  const fast = (leftMinutes: number | null, unlimited: boolean) => {
    if (unlimited || !fastUnlimited) return {};
    return {
      fastUnlimited: true,
      fastStandardSpeed:
        input.fastStandardSpeed === true || (leftMinutes !== null && leftMinutes <= 0),
    };
  };
  if (hours) {
    const leftMinutes = hours.unlimited ? null : hours.balanceMinutes;
    return {
      unlimited: hours.unlimited,
      leftMinutes,
      monthlyHours: hours.monthlyHours,
      usedTodayMinutes: usedToday,
      premiumUsd,
      power,
      ...fast(leftMinutes, hours.unlimited),
    };
  }
  const fromMe = input.balance?.aiHoursMinutes ?? null;
  // Fast-unlimited plan with the hours gone: still a plan with Uno AI.
  if (fromMe === null || (fromMe <= 0 && !fastUnlimited)) return null;
  return {
    unlimited: false,
    leftMinutes: Math.max(0, fromMe),
    monthlyHours: 0,
    usedTodayMinutes: usedToday,
    premiumUsd,
    power,
    ...fast(Math.max(0, fromMe), false),
  };
}

/**
 * The Uno AI lines of a Fast-unlimited plan: "Uno AI: Fast is unlimited.
 * Smart comes in hours.", or — the hours gone — "Your Smart hours are used
 * up. Fast keeps going at standard speed." Null on other plans.
 */
export function aiFastLine(summary: AiHoursSummary): string | null {
  if (!summary.fastUnlimited) return null;
  return summary.fastStandardSpeed ? AI_SMART_USED_UP_LINE : AI_FAST_UNLIMITED_LINE;
}

/** The note next to AI time. */
export function aiTimeNote(_summary?: AiHoursSummary): string {
  return AI_TIME_NOTE;
}

/**
 * The small words after the headline: "Smart left · Fast is unlimited",
 * "AI time · never expires", "full speed, then standard".
 */
export function aiHoursCaption(summary: AiHoursSummary): string {
  if (summary.unlimited) return "full speed, then standard";
  if (summary.fastUnlimited) return "Smart left · Fast is unlimited";
  return "AI time · never expires";
}

/** "87 h left" / "Unlimited AI". */
export function aiHoursHeadline(summary: AiHoursSummary): string {
  if (summary.unlimited || summary.leftMinutes === null) return "Unlimited AI";
  // "3 h 25 min" + the caption "Smart left · Fast is unlimited".
  if (summary.fastUnlimited) return formatAiMinutes(summary.leftMinutes);
  return `${formatAiMinutes(summary.leftMinutes)} left`;
}

/** "AI time: 87 h left · never expires" (+ " · $12.40 premium credit"). */
export function aiHoursLine(summary: AiHoursSummary, formatUsd: (usd: number) => string): string {
  const head = summary.unlimited
    ? "Unlimited AI"
    : `AI time: ${aiHoursHeadline(summary)} · never expires`;
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

/** What the plan's Uno AI is, in one line: "40 h of AI time a month · AI power ×1". */
export function planAiHoursLine(
  plan: Pick<AccountPlan, "aiHoursMonthly" | "aiHoursUnlimited" | "aiFullSpeedHours" | "aiPower">,
): string | null {
  if (plan.aiHoursUnlimited) {
    const fullSpeed =
      plan.aiFullSpeedHours !== null ? ` · ${plan.aiFullSpeedHours} h a month at full speed` : "";
    return `Unlimited AI${fullSpeed}`;
  }
  if (plan.aiHoursMonthly === null) return null;
  const hours = `${plan.aiHoursMonthly} h of AI time a month`;
  return plan.aiPower ? `${hours} · AI power ×${plan.aiPower}` : hours;
}
