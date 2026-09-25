/**
 * The words and numbers of "Plan & billing" in Uno Work: the plan ladder (the
 * same one the console sells), what the current plan includes and how much of
 * it is used, and what each computer costs out of the plan. Pure functions,
 * unit-tested.
 */
import type {
  AccountComputer,
  AccountPlan,
  AccountSubscription,
  PlanCatalog,
} from "./accountOverview";
import { planHasUnoAi } from "./aiHours";

export function formatUsd(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

export function formatRam(mb: number): string {
  if (mb <= 0) return "0 GB";
  const gb = mb / 1024;
  if (gb < 1) return `${Math.round(mb)} MB`;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 GB";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1).replace(/\.0$/, "")} TB`;
  if (gb >= 1) return `${gb.toFixed(1).replace(/\.0$/, "")} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "4 GB · 2 cores" */
export function computerSize(ramMb: number, vcpu: number): string {
  return `${formatRam(ramMb)} · ${vcpu} ${vcpu === 1 ? "core" : "cores"}`;
}

/** One step of the ladder: the computer, with and without Uno AI credits. */
export interface PlanRung {
  readonly key: string;
  readonly name: string;
  readonly plain: AccountPlan | null;
  readonly withAi: AccountPlan | null;
}

/**
 * The ladder the person can buy, cheapest first. With plans v2 the two
 * flavours of a computer (`plus`, `plus-ai`) are one rung with an "Uno AI"
 * switch; old catalogs are one plan per rung. A legacy plan the account still
 * pays for is not on the ladder — it is shown as the current plan.
 */
export function planLadder(catalog: PlanCatalog): ReadonlyArray<PlanRung> {
  const onSale = catalog.plans.filter((plan) => !plan.legacy);
  const byKey = new Map<
    string,
    { name: string; plain: AccountPlan | null; withAi: AccountPlan | null }
  >();
  for (const plan of onSale) {
    const key = catalog.plansV2 ? plan.baseSlug : plan.slug;
    const rung = byKey.get(key) ?? { name: plan.name, plain: null, withAi: null };
    if (planHasUnoAi(plan)) rung.withAi = plan;
    else rung.plain = plan;
    byKey.set(key, rung);
  }
  return Array.from(
    byKey.entries(),
    ([key, rung]): PlanRung => ({ key, name: rung.name, plain: rung.plain, withAi: rung.withAi }),
  ).toSorted((a, b) => rungPrice(a) - rungPrice(b));
}

function rungPrice(rung: PlanRung): number {
  return (rung.plain ?? rung.withAi)?.priceUsd ?? 0;
}

export function findPlan(catalog: PlanCatalog | undefined, slug: string | null | undefined) {
  if (!catalog || !slug) return null;
  return catalog.plans.find((plan) => plan.slug === slug) ?? null;
}

/** The plan's name as a person reads it: "Plus + Uno AI", "Builder". */
export function planTitle(
  plan: Pick<AccountPlan, "name" | "slug" | "baseSlug" | "aiCreditsUsd" | "aiHoursMonthly"> | null,
  slug?: string,
) {
  if (!plan) {
    if (slug === "trial") return "Free course";
    return slug
      ? slug.replace(
          /(^|-)([a-z])/g,
          (_m, d: string, c: string) => (d ? " " : "") + c.toUpperCase(),
        )
      : "No plan";
  }
  return planHasUnoAi(plan) ? `${plan.name} + Uno AI` : plan.name;
}

export interface UsageLine {
  readonly key: string;
  readonly label: string;
  /** "2 GB of 4 GB" */
  readonly value: string;
  /** 0..100, null when there is nothing to measure against. */
  readonly pct: number | null;
  readonly hint?: string;
}

function pct(used: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

/** What the plan includes, and how much of it is in use right now. */
export function usageLines(input: {
  readonly subscription: AccountSubscription;
  readonly cloudUsedBytes: number | null;
  readonly cloudQuotaBytes: number | null;
  readonly sitesUsedBytes: number | null;
  readonly sitesLimitBytes: number | null;
  readonly computers: number;
}): ReadonlyArray<UsageLine> {
  const { subscription } = input;
  const limits = subscription.limits;
  const lines: UsageLine[] = [];
  if (limits) {
    lines.push({
      key: "compute",
      label: "Computers running now",
      value: `${formatRam(subscription.usage.runningRamMb)} of ${formatRam(limits.peakRamMb)} · ${subscription.usage.runningVcpu} of ${limits.peakVcpu} cores`,
      pct: pct(subscription.usage.runningRamMb, limits.peakRamMb),
      hint:
        input.computers === 1
          ? "1 computer on the account. Sleeping computers don't count."
          : `${input.computers} computers on the account. Sleeping computers don't count.`,
    });
    const diskTotal = subscription.diskGbOverride ?? limits.diskGb;
    lines.push({
      key: "disk",
      label: "Working disk",
      value: `${round1(subscription.usage.diskGbUsed)} of ${diskTotal} GB`,
      pct: pct(subscription.usage.diskGbUsed, diskTotal),
      hint: "Where programs run. Shared by all your computers.",
    });
  }
  const cloudQuota =
    input.cloudQuotaBytes && input.cloudQuotaBytes > 0
      ? input.cloudQuotaBytes
      : limits && limits.cloudGb > 0
        ? limits.cloudGb * 1024 ** 3
        : 0;
  if (cloudQuota > 0 || input.cloudUsedBytes !== null) {
    lines.push({
      key: "cloud",
      label: "Cloud",
      value:
        cloudQuota > 0
          ? `${formatBytes(input.cloudUsedBytes ?? 0)} of ${formatBytes(cloudQuota)}`
          : formatBytes(input.cloudUsedBytes ?? 0),
      pct: pct(input.cloudUsedBytes ?? 0, cloudQuota),
      hint: "Where files live — documents, photos, app data.",
    });
  }
  if (input.sitesLimitBytes && input.sitesLimitBytes > 0) {
    lines.push({
      key: "sites",
      label: "Sites",
      value: `${formatBytes(input.sitesUsedBytes ?? 0)} of ${formatBytes(input.sitesLimitBytes)}`,
      pct: pct(input.sitesUsedBytes ?? 0, input.sitesLimitBytes),
      hint: "Uno Hosting. Sites stay up even when every computer sleeps.",
    });
  }
  return lines;
}

function round1(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * What a computer costs, as a share of the plan: the plan pays for a
 * computer's worth of memory, and this one takes `ramMb` of it. Null when the
 * plan does not say (no plan, a free course).
 */
export function computerMonthlyShare(
  computer: Pick<AccountComputer, "ramMb">,
  subscription: AccountSubscription | null,
): number | null {
  const limits = subscription?.limits;
  if (!limits || limits.peakRamMb <= 0 || limits.computePriceUsd <= 0) return null;
  const share = Math.min(1, computer.ramMb / limits.peakRamMb);
  return Math.round(limits.computePriceUsd * share * 100) / 100;
}

/** A switch from the current plan: up, down, or the same. */
export function planDirection(
  current: AccountSubscription | null,
  target: AccountPlan,
): "current" | "upgrade" | "downgrade" | "start" {
  if (!current) return "start";
  if (current.plan === target.slug) return "current";
  const currentPrice = current.limits?.priceUsd ?? current.priceUsd;
  if (target.priceUsd > currentPrice) return "upgrade";
  if (target.priceUsd === currentPrice && target.peakRamMb > (current.limits?.peakRamMb ?? 0)) {
    return "upgrade";
  }
  return "downgrade";
}
