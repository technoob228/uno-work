/**
 * "A computer of its own" in the assistant wizard — the rules, free of React.
 *
 * Before the button: can this account make one more Uno Work computer right
 * now? The answer comes from the same console reads My Uno uses (the plan and
 * its limits, what runs now, the plan catalog), and is one of
 *
 *   create   — the plan has room: "Create its computer";
 *   upgrade  — the plan can't hold it (no plan, paused, ended, too small, full):
 *              "Needs an upgrade" + a button to the console's checkout of the
 *              plan that can (`checkoutHref`, the same link as My Uno's "Get …");
 *   signin   — not signed in to Uno here;
 *   unavailable — this page can't reach the Uno account at all.
 *
 * A read that fails is not a "no": the console is the only judge, so the
 * wizard then offers "Create" and turns a refusal into the same upgrade card
 * (`describeOwnComputerFailure`).
 */
import {
  type AccountPlan,
  type AccountSubscription,
  type PlanCatalog,
  CONSOLE_URL,
  checkoutHref,
  consoleLinks,
} from "../../account/accountOverview";
import { planHasUnoAi } from "../../account/aiHours";
import { formatRam, planTitle } from "../../account/billingModel";
import { CHOOSE_PLAN_URL } from "../../account/planStatus";
import { describeMachineError } from "../../machineErrors";
import {
  UNO_BOX_NAME_MAX_LENGTH,
  UNO_BOX_SIZE_PRESETS,
  normalizeUnoBoxName,
} from "../../unoBoxCreation";

/** Uno Work's own floor (the Work image needs 4 GB): the smallest that runs it, nothing to pick. */
export const OWN_COMPUTER_SHAPE = {
  ramMb: UNO_BOX_SIZE_PRESETS.medium.ramMb,
  vcpu: UNO_BOX_SIZE_PRESETS.medium.vcpu,
  diskGb: UNO_BOX_SIZE_PRESETS.medium.diskGb,
} as const;

export const OWN_COMPUTER_SIZE_LINE = UNO_BOX_SIZE_PRESETS.medium.description;

const SUFFIX = "-computer";

/**
 * `<name>-computer`, DNS-ish (the box name goes into its address), and not one
 * the account already has (`-2`, `-3`…).
 */
export function ownComputerName(assistantName: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  const room = UNO_BOX_NAME_MAX_LENGTH - SUFFIX.length - 3;
  const base =
    normalizeUnoBoxName(
      assistantName
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .slice(0, room * 2),
    )
      .slice(0, room)
      .replace(/-+$/g, "") || "assistant";
  const first = `${base}${SUFFIX}`;
  if (!used.has(first)) return first;
  for (let i = 2; i < 100; i += 1) {
    const next = `${first}-${i}`;
    if (!used.has(next)) return next;
  }
  return first;
}

// ── Before the button ────────────────────────────────────────────────────

export type OwnComputerUpgradeReason =
  | "no_plan"
  | "ended"
  | "paused"
  | "too_small"
  | "busy"
  | "disk"
  | "balance";

export interface OwnComputerUpgrade {
  readonly kind: "upgrade";
  readonly reason: OwnComputerUpgradeReason;
  readonly title: string;
  readonly message: string;
  /** Button text: "Get Builder — $22/mo", "Pay for Plus", "Choose a plan". */
  readonly cta: string;
  /** The console page that takes the payment (checkout of that plan when known). */
  readonly href: string;
  readonly plan: { readonly slug: string; readonly name: string; readonly priceUsd: number } | null;
  /**
   * The plan may have room once something else sleeps (it counts what runs
   * now): the wizard keeps "Create anyway" next to the upgrade.
   */
  readonly canTryAnyway: boolean;
}

export type OwnComputerDecision =
  | {
      readonly kind: "create";
      /** "Plus", or null when the plan couldn't be read (the console decides). */
      readonly planName: string | null;
    }
  | OwnComputerUpgrade
  | { readonly kind: "signin"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

function priceLine(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}/mo` : `$${usd.toFixed(2)}/mo`;
}

function runsWork(plan: AccountPlan): boolean {
  return plan.cloudWork && plan.maxBoxRamMb >= OWN_COMPUTER_SHAPE.ramMb;
}

/** Memory that can run at once on this plan, and how much of it runs now. */
function runningRoom(sub: AccountSubscription): { at: number; now: number } | null {
  if (sub.alwaysOn && sub.alwaysOn.ramMb > 0) {
    return { at: sub.alwaysOn.ramMb, now: sub.alwaysOn.runningRamMb };
  }
  const at = sub.limits?.peakRamMb ?? 0;
  return at > 0 ? { at, now: sub.usage.runningRamMb } : null;
}

function planDiskGb(sub: AccountSubscription): number {
  return sub.diskGbOverride ?? sub.limits?.diskGb ?? 0;
}

/**
 * The cheapest plan to sell for this: runs Uno Work in the cloud, and — when
 * the account has a plan — is bigger than it where it falls short. Same
 * "with Uno AI or not" as the plan now (no plan: without, like the console's
 * own checkout link for agents).
 */
export function upgradePlanFor(
  catalog: PlanCatalog | null | undefined,
  subscription: AccountSubscription | null,
  reason: OwnComputerUpgradeReason,
): AccountPlan | null {
  if (!catalog) return null;
  const current = subscription?.limits ?? null;
  const withAi = current ? planHasUnoAi(current) : false;
  const need = OWN_COMPUTER_SHAPE.ramMb;
  const room = subscription ? runningRoom(subscription) : null;
  const usedDisk = subscription?.usage.diskGbUsed ?? 0;
  const fits = (plan: AccountPlan) => {
    if (plan.legacy || plan.priceUsd <= 0 || !runsWork(plan)) return false;
    if (!current || reason === "no_plan" || reason === "ended") return true;
    if (plan.slug === current.slug) return false;
    if (reason === "too_small") return plan.maxBoxRamMb > current.maxBoxRamMb;
    if (reason === "busy") {
      const at = plan.alwaysOn?.ramMb ?? plan.peakRamMb;
      return at - (room?.now ?? 0) >= need;
    }
    if (reason === "disk") return plan.diskGb - usedDisk >= OWN_COMPUTER_SHAPE.diskGb;
    return plan.priceUsd > current.priceUsd;
  };
  const candidates = catalog.plans.filter(fits).toSorted((a, b) => a.priceUsd - b.priceUsd);
  return candidates.find((plan) => planHasUnoAi(plan) === withAi) ?? candidates[0] ?? null;
}

function upgradeCard(input: {
  readonly reason: OwnComputerUpgradeReason;
  readonly title: string;
  readonly message: string;
  readonly catalog: PlanCatalog | null | undefined;
  readonly subscription: AccountSubscription | null;
  readonly canTryAnyway?: boolean;
  /** A checkout link the console itself sent with a refusal. */
  readonly checkoutUrl?: string | null;
}): OwnComputerUpgrade {
  const { reason, subscription } = input;
  const base = {
    kind: "upgrade" as const,
    reason,
    title: input.title,
    message: input.message,
    canTryAnyway: input.canTryAnyway ?? false,
  };
  if (reason === "balance") {
    return { ...base, cta: "Add money", href: consoleLinks.addMoney, plan: null };
  }
  if (reason === "paused" && subscription) {
    // Paying the same plan wakes everything up (the console's own rule).
    const name = planTitle(subscription.limits, subscription.plan);
    return {
      ...base,
      cta: `Pay for ${name}`,
      href: input.checkoutUrl ?? checkoutHref(subscription.plan),
      plan: subscription.limits
        ? { slug: subscription.plan, name, priceUsd: subscription.limits.priceUsd }
        : null,
    };
  }
  const plan = upgradePlanFor(input.catalog, subscription, reason);
  if (input.checkoutUrl) {
    return {
      ...base,
      cta: plan ? `Get ${plan.name}` : "Choose a plan",
      href: input.checkoutUrl,
      plan: plan ? { slug: plan.slug, name: plan.name, priceUsd: plan.priceUsd } : null,
    };
  }
  if (!plan) return { ...base, cta: "Choose a plan", href: CHOOSE_PLAN_URL, plan: null };
  return {
    ...base,
    cta: `Get ${plan.name} — ${priceLine(plan.priceUsd)}`,
    href: checkoutHref(plan.slug),
    plan: { slug: plan.slug, name: plan.name, priceUsd: plan.priceUsd },
  };
}

const SIZE = formatRam(OWN_COMPUTER_SHAPE.ramMb);

/**
 * What the wizard offers, from the account's plan (`null`: no plan) and the
 * catalog. `subscription === undefined` — the plan couldn't be read: offer
 * Create and let the console decide.
 */
export function decideOwnComputer(input: {
  readonly subscription: AccountSubscription | null | undefined;
  readonly catalog: PlanCatalog | null | undefined;
}): OwnComputerDecision {
  const { subscription: sub, catalog } = input;
  if (sub === undefined) return { kind: "create", planName: null };
  const card = (
    reason: OwnComputerUpgradeReason,
    title: string,
    message: string,
    canTryAnyway = false,
  ) => upgradeCard({ reason, title, message, catalog, subscription: sub, canTryAnyway });
  if (sub === null) {
    return card(
      "no_plan",
      "Needs a plan",
      `A computer of its own comes with a plan that runs Uno Work in the cloud (${SIZE}).`,
    );
  }
  const name = planTitle(sub.limits, sub.plan);
  if (sub.planEndedAt) {
    return card(
      "ended",
      "Needs a plan",
      `Your ${name} plan has ended. Choose a plan to add computers.`,
    );
  }
  if (sub.status === "suspended" || sub.status === "past_due") {
    return card(
      "paused",
      "Needs a payment",
      `Your ${name} plan is waiting for a payment. Pay it and you can add computers again.`,
    );
  }
  const limits = sub.limits;
  // A console that doesn't send the limits: it judges on Create.
  if (!limits) return { kind: "create", planName: name };
  if (!runsWork(limits)) {
    return card(
      "too_small",
      "Needs an upgrade",
      limits.maxBoxRamMb > 0
        ? `Uno Work needs a ${SIZE} computer; on ${name} a computer goes up to ${formatRam(limits.maxBoxRamMb)}.`
        : `Uno Work in the cloud isn't part of ${name}.`,
    );
  }
  const diskGb = planDiskGb(sub);
  if (diskGb > 0 && diskGb - sub.usage.diskGbUsed < OWN_COMPUTER_SHAPE.diskGb) {
    return card(
      "disk",
      "Needs an upgrade",
      `Your plan's disk is full: ${sub.usage.diskGbUsed} of ${diskGb} GB are taken, and a new computer needs ${OWN_COMPUTER_SHAPE.diskGb} GB.`,
    );
  }
  const room = runningRoom(sub);
  if (room && room.at - room.now < OWN_COMPUTER_SHAPE.ramMb) {
    return card(
      "busy",
      "Needs an upgrade",
      `${name} runs ${formatRam(room.at)} at once and ${formatRam(room.now)} is on now; its computer needs ${SIZE}. Put a computer to sleep, or upgrade.`,
      true,
    );
  }
  return { kind: "create", planName: name };
}

// ── After the button ─────────────────────────────────────────────────────

export interface OwnComputerError {
  readonly kind: "error";
  readonly title: string;
  readonly message: string;
  readonly details: string | null;
}

function textOf(error: unknown): string {
  if (error instanceof Error) {
    const body = (error as { body?: unknown }).body;
    const extra = body && typeof body === "object" ? ` ${JSON.stringify(body)}` : "";
    return `${error.message}${extra}`;
  }
  return typeof error === "string" ? error : String(error);
}

/** A checkout link inside the console's refusal (402 PLAN_REQUIRED, WORK_TRIAL_ENDED). */
function checkoutUrlIn(text: string): string | null {
  const match = /"checkout_url"\s*:\s*"([^"]+)"/.exec(text);
  const url = match?.[1]?.replace(/\\u0026/g, "&").replace(/\\\//g, "/") ?? null;
  return url && url.startsWith(CONSOLE_URL) ? url : null;
}

/**
 * A failed "Create its computer" in words. A plan refusal becomes the same
 * upgrade card as before the button; everything else is an honest error
 * (the raw text only under "Show details").
 */
export function describeOwnComputerFailure(
  error: unknown,
  context: {
    readonly subscription: AccountSubscription | null | undefined;
    readonly catalog: PlanCatalog | null | undefined;
  },
): OwnComputerUpgrade | OwnComputerError {
  const raw = textOf(error);
  const has = (code: string) => raw.includes(code);
  const sub = context.subscription ?? null;
  const card = (
    reason: OwnComputerUpgradeReason,
    title: string,
    message: string,
    tryAnyway = false,
  ) =>
    upgradeCard({
      reason,
      title,
      message,
      catalog: context.catalog,
      subscription: sub,
      canTryAnyway: tryAnyway,
      checkoutUrl: checkoutUrlIn(raw),
    });
  if (
    has("NO_SUBSCRIPTION") ||
    has("SUBSCRIPTION_REQUIRED") ||
    /"reason"\s*:\s*"no_plan"/.test(raw)
  ) {
    return card(
      "no_plan",
      "Needs a plan",
      "A computer of its own comes with a plan. Nothing was created.",
    );
  }
  if (has("WORK_TRIAL_ENDED") || has("PLAN_ENDED") || /"reason"\s*:\s*"trial_ended"/.test(raw)) {
    return card(
      "ended",
      "Needs a plan",
      "Your free time has ended. Choose a plan to add computers.",
    );
  }
  if (
    has("PAYMENT_OVERDUE") ||
    has("SUBSCRIPTION_INACTIVE") ||
    /"reason"\s*:\s*"plan_paused"/.test(raw)
  ) {
    return card(
      "paused",
      "Needs a payment",
      "Your plan is waiting for a payment. Nothing was created.",
    );
  }
  if (has("PLAN_WORK_ONLY") || /"reason"\s*:\s*"trial_limit"/.test(raw)) {
    return card(
      "too_small",
      "Needs an upgrade",
      "The free trial includes one Uno Work computer. Choose a plan to give it a computer of its own.",
    );
  }
  if (has("SHAPE_TOO_LARGE") || /"reason"\s*:\s*"plan_too_small"/.test(raw)) {
    return card(
      "too_small",
      "Needs an upgrade",
      `Uno Work needs a ${SIZE} computer, bigger than your plan allows.`,
    );
  }
  if (has("PEAK_EXCEEDED")) {
    return card(
      "busy",
      "Needs an upgrade",
      "Your plan is running as much as it can at once. Put a computer to sleep, or upgrade.",
      true,
    );
  }
  if (has("POOL_EXHAUSTED")) {
    return card(
      "busy",
      "Needs an upgrade",
      "This month's computer hours on your plan are used up.",
    );
  }
  if (has("DISK_QUOTA_EXCEEDED")) {
    return card("disk", "Needs an upgrade", "Your plan's disk is full. Nothing was created.");
  }
  if (
    has("INSUFFICIENT_BALANCE") ||
    has("NO_BALANCE") ||
    /"reason"\s*:\s*"balance_short"/.test(raw)
  ) {
    return card(
      "balance",
      "Needs money on the balance",
      "Your Uno balance is short. Nothing was created.",
    );
  }
  const details = raw.length > 0 ? raw.slice(0, 600) : null;
  if (has("BUDGET_GUARD")) {
    return {
      kind: "error",
      title: "Your spending limit stopped it",
      message: "A limit you set in the Uno console says no. Raise it there, then try again.",
      details,
    };
  }
  if (has("ASSISTANT_LIMIT")) {
    return {
      kind: "error",
      title: "Too many assistants",
      message:
        "This account already has the most assistants with their own computers. Remove one first.",
      details,
    };
  }
  if (
    has("INVALID_COMPUTER_ROLE") ||
    has("ASSISTANT_NEEDS_WORK_IMAGE") ||
    has("INVALID_ASSISTANT")
  ) {
    return {
      kind: "error",
      title: "Not available on this account yet",
      message:
        "Uno can't make assistant computers for this account yet. Pick one of your computers above for now.",
      details,
    };
  }
  const human = describeMachineError(error);
  return { kind: "error", title: human.title, message: human.message, details: human.details };
}
