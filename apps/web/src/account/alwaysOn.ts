/**
 * Plans "always on" (generation 2, `plan_view: "always_on"`): the person buys
 * a computer that is always reachable — "Always on · 4 GB" — and sees two
 * numbers, never computer hours:
 *
 *   - "Running now · 3 of 4 GB" — what runs at once (sleeping computers don't count);
 *   - "⚡ Boosts · 23 left" — the plan's boosts plus the ones earned asleep.
 *
 * Older plans (`plan_view: "hours"`) and an older console (no `plan_view`)
 * keep the screens they had: every reader here returns null or false then.
 * Copy is the canon of reports/day_2026-10-05/pricing-impl/CONTRACT.md.
 * Pure functions, unit-tested.
 */
import type {
  AccountComputer,
  AccountPlan,
  AccountSubscription,
  PlanCatalog,
  SubscriptionAlwaysOn,
  SubscriptionBoosts,
} from "./accountOverview";
import { planHasUnoAi } from "./aiHours";
import { formatRam, formatUsd } from "./billingModel";

export const ALWAYS_ON_EXPLAINER =
  "Always on means always reachable: a computer with nothing to do sleeps after 10 minutes and wakes in about a second.";
export const SLEEPING_DONT_COUNT = "Sleeping computers don't count.";
export const WORKS_WITH_UNO_AI = "Works with Uno AI";
export const ON_BOOSTS_LABEL = "on boosts";
export const OUT_OF_BOOSTS_LABEL = "Asleep — boosts ran out";

/** The subscription reads as "always on" (and has the numbers for it). */
export function showsAlwaysOn(
  subscription: AccountSubscription | null | undefined,
): subscription is AccountSubscription & { readonly alwaysOn: SubscriptionAlwaysOn } {
  return subscription?.planView === "always_on" && subscription.alwaysOn !== null;
}

/**
 * The plan ladder reads "always on": for a subscriber, by its `plan_view`
 * ("hours" and an older console keep the old cards); with no plan or on a
 * trial, by the account's `plan_always_on` feature.
 */
export function alwaysOnLadder(
  subscription: AccountSubscription | null | undefined,
  features: ReadonlyArray<string> | null | undefined,
): boolean {
  if (subscription && subscription.planView !== "trial") {
    return subscription.planView === "always_on";
  }
  return (features ?? []).includes("plan_always_on");
}

/** "3 of 4 GB" — the unit once when both are gigabytes, "512 MB of 4 GB" otherwise. */
export function ofGb(usedMb: number, totalMb: number): string {
  const used = Math.max(0, usedMb);
  if (used > 0 && used < 1024) return `${formatRam(used)} of ${formatRam(totalMb)}`;
  const total = formatRam(totalMb);
  return `${formatRam(used).replace(/ GB$/, "")} of ${total}`;
}

/** "Always on · 4 GB" */
export function alwaysOnTitle(ramMb: number): string {
  return `Always on · ${formatRam(ramMb)}`;
}

/**
 * "Running now · 3 of 4 GB"; with computers past the plan:
 * "Running now · 4 of 4 GB + 4 GB on boosts".
 */
export function runningNowLine(always: SubscriptionAlwaysOn): string {
  const extra = Math.min(always.onBoostsRamMb, always.runningRamMb);
  const inPlan = always.runningRamMb - extra;
  const head = `Running now · ${ofGb(inPlan, always.ramMb)}`;
  return extra > 0 ? `${head} + ${formatRam(extra)} ${ON_BOOSTS_LABEL}` : head;
}

/** 0..100 of the always-on memory in use (past the plan reads as full). */
export function runningNowPct(always: SubscriptionAlwaysOn): number {
  if (always.ramMb <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((always.runningRamMb / always.ramMb) * 100)));
}

/** "Nov 1" — the day the month's boosts start over (00:00 UTC). */
export function boostResetDay(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (Number.isNaN(at)) return null;
  return new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function boostsCount(n: number): string {
  return `${n} ${n === 1 ? "boost" : "boosts"}`;
}

/** "⚡ Boosts · 23 left" */
export function boostsTitle(boosts: Pick<SubscriptionBoosts, "left">): string {
  return `⚡ Boosts · ${boosts.left} left`;
}

/** "10 with your plan + 13 earned while asleep · new on Nov 1" */
export function boostsBreakdown(
  boosts: Pick<SubscriptionBoosts, "perMonth" | "earned" | "resetsAt">,
): string {
  const parts = [`${boosts.perMonth} with your plan`];
  if (boosts.earned > 0) parts.push(`${boosts.earned} earned while asleep`);
  const day = boostResetDay(boosts.resetsAt);
  return day ? `${parts.join(" + ")} · new on ${day}` : parts.join(" + ");
}

/**
 * "1 boost = 4 GB more for an hour. Every hour a computer sleeps earns one
 * (up to 20 a month)." The earning half only when Uno pays for sleep.
 */
export function boostUnitSentence(
  boosts: Pick<SubscriptionBoosts, "unitRamMb" | "earn">,
  fallbackUnitRamMb = 0,
): string {
  const unit = boosts.unitRamMb > 0 ? boosts.unitRamMb : fallbackUnitRamMb;
  const head = unit > 0 ? `1 boost = ${formatRam(unit)} more for an hour.` : "";
  const earn = sleepEarnsSentence(boosts.earn);
  return [head, earn].filter(Boolean).join(" ");
}

/**
 * "Every hour a computer sleeps earns one (up to 20 a month)." Null when
 * sleep earns nothing for this account.
 */
export function sleepEarnsSentence(earn: SubscriptionBoosts["earn"] | undefined): string | null {
  if (!earn?.enabled || earn.perSleepHour <= 0) return null;
  const cap = earn.monthlyCap > 0 ? ` (up to ${earn.monthlyCap} a month)` : "";
  const every = Math.round(1 / earn.perSleepHour);
  return every <= 1
    ? `Every hour a computer sleeps earns one${cap}.`
    : `Every ${every} hours a computer sleeps earn one${cap}.`;
}

/** "What if I need more?" — only when starting past the plan on boosts is on. */
export function needMoreSentence(alwaysOnRamMb: number): string {
  const gb = formatRam(alwaysOnRamMb);
  return `Need more than ${gb}? Start another computer on boosts. When boosts run out, it goes to sleep — your main computer stays on.`;
}

/** "less than an hour", "about an hour", "about 5 hours", "about a day", "about 3 days". */
export function aboutDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 1) return "less than an hour";
  if (hours < 1.5) return "about an hour";
  if (hours < 20) return `about ${Math.round(hours)} hours`;
  if (hours < 36) return "about a day";
  return `about ${Math.round(hours / 24)} days`;
}

/** "1 boost an hour", "½ boost an hour", "2 boosts an hour". */
export function boostRate(perHour: number): string {
  if (perHour > 0 && perHour < 1) {
    const half = Math.abs(perHour - 0.5) < 0.01;
    return `${half ? "½" : perHour.toFixed(2).replace(/0$/, "")} boost an hour`;
  }
  const n = Math.round(perHour * 10) / 10;
  return `${n} ${n === 1 ? "boost" : "boosts"} an hour`;
}

/** "Using 1 boost an hour right now — enough for about a day." Null when none burn. */
export function boostsBurningLine(boosts: SubscriptionBoosts): string | null {
  if (boosts.burningPerHour <= 0) return null;
  const hours =
    boosts.hoursLeftAtThisRate ??
    (boosts.burningPerHour > 0 ? boosts.leftExact / boosts.burningPerHour : null);
  const rate = `Using ${boostRate(boosts.burningPerHour)} right now`;
  return hours === null ? `${rate}.` : `${rate} — enough for ${aboutDuration(hours)}.`;
}

// ---- plan cards ----

export interface AlwaysOnCard {
  /** "Always on 4 GB" */
  readonly alwaysOn: string;
  /** "⚡ 10 boosts a month"; null for a plan without boosts. */
  readonly boosts: string | null;
  /** "Works with Uno AI" / "Uno AI: Fast is unlimited. Smart comes in hours." (shown after ✦). */
  readonly ai: string;
}

/**
 * A plan card says three numbers at most — price, GB, boosts — and one Uno
 * AI line. Null when the console sends no always-on figures for the plan.
 */
export function alwaysOnCard(plan: AccountPlan): AlwaysOnCard | null {
  const always = plan.alwaysOn;
  if (!always) return null;
  return {
    alwaysOn: `Always on ${formatRam(always.ramMb)}`,
    boosts: always.boostsPerMonth > 0 ? `⚡ ${boostsCount(always.boostsPerMonth)} a month` : null,
    ai: planAiOneLine(plan),
  };
}

export const FAST_UNLIMITED_LINE = "Uno AI: Fast is unlimited. Smart comes in hours.";

function planAiOneLine(plan: AccountPlan): string {
  if (!planHasUnoAi(plan)) return WORKS_WITH_UNO_AI;
  if (plan.aiHoursUnlimited) return "Uno AI: unlimited";
  if (plan.aiFastUnlimited) return FAST_UNLIMITED_LINE;
  return "Uno AI included";
}

/**
 * The next plan up with more always-on memory (the same Uno AI flavour as the
 * current one), for "Get Pro — always on 16 GB, $70/mo". Null at the top.
 */
export function nextAlwaysOnPlan(
  catalog: PlanCatalog | null | undefined,
  subscription: AccountSubscription | null | undefined,
): AccountPlan | null {
  if (!catalog) return null;
  const currentRam = subscription?.alwaysOn?.ramMb ?? subscription?.limits?.alwaysOn?.ramMb ?? 0;
  const withAi = subscription?.limits ? planHasUnoAi(subscription.limits) : false;
  const up = catalog.plans
    .filter((plan) => !plan.legacy && plan.alwaysOn && plan.alwaysOn.ramMb > currentRam)
    .toSorted((a, b) => a.priceUsd - b.priceUsd);
  return up.find((plan) => planHasUnoAi(plan) === withAi) ?? up[0] ?? null;
}

/** "Get Pro — always on 16 GB, $70/mo" */
export function nextPlanLabel(plan: AccountPlan): string {
  const ram = plan.alwaysOn?.ramMb ?? plan.peakRamMb;
  return `Get ${plan.name} — always on ${formatRam(ram)}, ${formatUsd(plan.priceUsd)}/mo`;
}

// ---- starting a computer past the plan (stage 2) ----

export interface PeakExceeded {
  readonly message: string | null;
  readonly alwaysOnRamMb: number;
  readonly runningRamMb: number;
  readonly needRamMb: number;
  /** Null on a console that doesn't offer starting on boosts. */
  readonly runOnBoosts: {
    readonly possible: boolean;
    readonly boostsLeft: number;
    readonly boostsPerHour: number;
    readonly hoursAbout: number | null;
    readonly resetsAt: string | null;
    /** Why not, in the person's words (when `possible` is false). */
    readonly reason: string | null;
  } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function n(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function s(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The console's `409 PEAK_EXCEEDED` with its numbers — from the whole
 * answer (`AccountHttpError.body`), or from the error text when it was not
 * cut short. Null for any other error.
 */
export function parsePeakExceeded(error: unknown): PeakExceeded | null {
  const body =
    record((error as { body?: unknown } | null)?.body) ??
    record((error instanceof Error ? error.message : String(error)).replace(/^\d{3}:\s*/, ""));
  if (!body || body["error"] !== "PEAK_EXCEEDED") return null;
  const boosts = record(body["run_on_boosts"]);
  return {
    message: s(body["message"]),
    alwaysOnRamMb: n(body["always_on_ram_mb"]),
    runningRamMb: n(body["running_ram_mb"]),
    needRamMb: n(body["need_ram_mb"]),
    runOnBoosts: boosts
      ? {
          possible: boosts["possible"] === true,
          boostsLeft: Math.max(0, Math.floor(n(boosts["boosts_left"]))),
          boostsPerHour: n(boosts["boosts_per_hour"]),
          hoursAbout:
            typeof boosts["hours_about"] === "number" ? (boosts["hours_about"] as number) : null,
          resetsAt: s(boosts["resets_at"]),
          reason: s(boosts["reason"]),
        }
      : null,
  };
}

export interface RunPastPlanChoices {
  /** "Start “scraper” — 4 GB?" */
  readonly title: string;
  /** "Your always-on 4 GB is busy." */
  readonly lead: string;
  readonly boosts: {
    readonly possible: boolean;
    readonly title: string;
    /** "1 boost an hour · you have 23, about a day. When they run out it sleeps; uno-work stays on." */
    readonly detail: string;
  };
  /** Put a running computer to sleep to make room; null when none frees enough. */
  readonly sleep: { readonly computer: AccountComputer; readonly title: string } | null;
  readonly nextPlan: { readonly plan: AccountPlan; readonly title: string } | null;
}

const RUNNING = new Set(["running"]);

/**
 * The running computer whose sleep makes room for `needRamMb`: the smallest
 * that is enough (a server before an Uno Work computer of the same size).
 */
export function computerToSleep(
  computers: ReadonlyArray<AccountComputer>,
  peak: Pick<PeakExceeded, "alwaysOnRamMb" | "runningRamMb">,
  needRamMb: number,
): AccountComputer | null {
  const enough = computers
    .filter((c) => RUNNING.has(c.status) && !c.runOnBoosts)
    .filter((c) => peak.runningRamMb - c.ramMb + needRamMb <= peak.alwaysOnRamMb)
    .toSorted((a, b) => a.ramMb - b.ramMb || Number(a.workMachine) - Number(b.workMachine));
  return enough[0] ?? null;
}

/** The three ways out when a new computer doesn't fit in the always-on memory. */
export function runPastPlanChoices(input: {
  readonly name: string;
  readonly ramMb: number;
  readonly peak: PeakExceeded;
  readonly computers: ReadonlyArray<AccountComputer>;
  readonly nextPlan: AccountPlan | null;
}): RunPastPlanChoices {
  const { peak, name } = input;
  const need = peak.needRamMb > 0 ? peak.needRamMb : input.ramMb;
  const main =
    input.computers.find((c) => c.workMachine && RUNNING.has(c.status))?.name ??
    input.computers.find((c) => RUNNING.has(c.status))?.name ??
    "your main computer";
  const run = peak.runOnBoosts;
  const hours =
    run?.hoursAbout ??
    (run && run.boostsPerHour > 0 ? run.boostsLeft / run.boostsPerHour : Number.NaN);
  const boostsDetail = run?.possible
    ? `${boostRate(run.boostsPerHour > 0 ? run.boostsPerHour : 1)} · you have ${run.boostsLeft}, ${aboutDuration(hours)}. When they run out it sleeps; ${main} stays on.`
    : (run?.reason ?? "Starting past your plan isn't available right now.");
  const sleeping = computerToSleep(input.computers, peak, need);
  return {
    title: `Start “${name}” — ${formatRam(need)}?`,
    lead: `Your always-on ${formatRam(peak.alwaysOnRamMb)} is busy.`,
    boosts: {
      possible: run?.possible === true,
      title: "⚡ Run it on boosts",
      detail: boostsDetail,
    },
    sleep: sleeping
      ? {
          computer: sleeping,
          title: `Put ${sleeping.name} to sleep and start ${name} instead`,
        }
      : null,
    nextPlan: input.nextPlan
      ? { plan: input.nextPlan, title: nextPlanLabel(input.nextPlan) }
      : null,
  };
}

// ---- a computer that runs past the plan ----

const ASLEEP = new Set(["sleeping", "paused", "paused_ram", "stopped", "suspended"]);

/**
 * "on boosts" on a computer running past the plan; "Asleep — boosts ran
 * out" on one that slept because the boosts did. Null otherwise.
 */
export function boostsComputerTag(
  computer: Pick<AccountComputer, "runOnBoosts" | "status">,
  boosts: Pick<SubscriptionBoosts, "left"> | null | undefined,
): "on-boosts" | "out-of-boosts" | null {
  if (!computer.runOnBoosts) return null;
  if (RUNNING.has(computer.status)) return "on-boosts";
  if (ASLEEP.has(computer.status) && boosts && boosts.left < 1) return "out-of-boosts";
  return null;
}

/** "Asleep — boosts ran out. Wakes when your plan has room, or on Nov 1." */
export function outOfBoostsDetail(resetsAt: string | null | undefined): string {
  const day = boostResetDay(resetsAt);
  return day
    ? `${OUT_OF_BOOSTS_LABEL}. Wakes when your plan has room, or on ${day}.`
    : `${OUT_OF_BOOSTS_LABEL}. Wakes when your plan has room, or when boosts come back.`;
}
