import { describe, expect, it } from "vitest";

import {
  type AccountSubscription,
  type PlanCatalog,
  checkoutHref,
  consoleLinks,
  parseAccountPlan,
  parsePlanCatalog,
  parseSubscription,
} from "../../account/accountOverview";
import { CHOOSE_PLAN_URL } from "../../account/planStatus";
import {
  OWN_COMPUTER_SHAPE,
  decideOwnComputer,
  describeOwnComputerFailure,
  ownComputerName,
  upgradePlanFor,
} from "./ownComputer.logic";

const wirePlan = (slug: string, price: number, ramGb: number, peakGb: number, extra = {}) => ({
  slug,
  name: slug[0]!.toUpperCase() + slug.slice(1),
  price_usd: price,
  max_box: { ram_mb: ramGb * 1024, vcpu: Math.max(1, ramGb / 2) },
  peak: { ram_mb: peakGb * 1024, vcpu: peakGb / 2 },
  disk_gb: ramGb * 20,
  cloud_work: ramGb >= 4,
  ...extra,
});

const CATALOG: PlanCatalog = parsePlanCatalog({
  plans: [
    wirePlan("mini", 10, 2, 4),
    wirePlan("plus", 20, 4, 8),
    wirePlan("plus-ai", 40, 4, 8, { base_slug: "plus", ai_credits_usd: 20 }),
    wirePlan("pro", 69, 16, 32),
    wirePlan("old", 15, 8, 8, { legacy: true }),
  ],
});

function sub(
  plan: string,
  over: Record<string, unknown> = {},
  usage: Record<string, unknown> = {},
): AccountSubscription {
  const limits = CATALOG.plans.find((item) => item.slug === plan);
  const raw = {
    plan,
    status: "active",
    plan_limits: limits
      ? {
          ...wirePlan(plan, limits.priceUsd, limits.maxBoxRamMb / 1024, limits.peakRamMb / 1024),
          ...(plan === "plus-ai" ? { base_slug: "plus", ai_credits_usd: 20 } : {}),
        }
      : null,
    usage: { running_ram_mb: 0, disk_gb_used: 0, box_count: 1, ...usage },
    ...over,
  };
  return parseSubscription(raw)!;
}

describe("ownComputerName", () => {
  it("is <name>-computer, DNS-ish", () => {
    expect(ownComputerName("Mia")).toBe("mia-computer");
    expect(ownComputerName("  Bolt · Developer! ")).toBe("bolt-developer-computer");
    expect(ownComputerName("Zoë")).toBe("zoe-computer");
  });
  it("falls back to assistant and skips names the account has", () => {
    expect(ownComputerName("Мия")).toBe("assistant-computer");
    expect(ownComputerName("Mia", ["mia-computer", "MIA-COMPUTER-2"])).toBe("mia-computer-3");
  });
  it("stays within the box name limit", () => {
    expect(ownComputerName("a".repeat(80)).length).toBeLessThanOrEqual(40);
  });
});

describe("decideOwnComputer", () => {
  it("a plan with room: create", () => {
    expect(decideOwnComputer({ subscription: sub("plus"), catalog: CATALOG })).toEqual({
      kind: "create",
      planName: "Plus",
    });
  });

  it("the plan couldn't be read: create, the console decides", () => {
    expect(decideOwnComputer({ subscription: undefined, catalog: null })).toEqual({
      kind: "create",
      planName: null,
    });
  });

  it("no plan: the cheapest plan that runs Work, to its checkout", () => {
    const decision = decideOwnComputer({ subscription: null, catalog: CATALOG });
    expect(decision).toMatchObject({
      kind: "upgrade",
      reason: "no_plan",
      href: checkoutHref("plus"),
      cta: "Get Plus — $20/mo",
      plan: { slug: "plus" },
    });
  });

  it("a plan too small for Work: the next one up, same AI-ness", () => {
    const decision = decideOwnComputer({ subscription: sub("mini"), catalog: CATALOG });
    expect(decision).toMatchObject({
      kind: "upgrade",
      reason: "too_small",
      plan: { slug: "plus" },
    });
    expect(decision.kind === "upgrade" && decision.message).toContain("up to 2 GB");
  });

  it("everything running already: upgrade, but 'Create anyway' stays", () => {
    const decision = decideOwnComputer({
      subscription: sub("plus", {}, { running_ram_mb: 6 * 1024 }),
      catalog: CATALOG,
    });
    expect(decision).toMatchObject({
      kind: "upgrade",
      reason: "busy",
      canTryAnyway: true,
      plan: { slug: "pro" },
    });
  });

  it("disk full: upgrade", () => {
    expect(
      decideOwnComputer({ subscription: sub("plus", {}, { disk_gb_used: 70 }), catalog: CATALOG }),
    ).toMatchObject({ kind: "upgrade", reason: "disk", plan: { slug: "pro" } });
  });

  it("a paused plan: pay the same plan", () => {
    expect(
      decideOwnComputer({ subscription: sub("plus", { status: "suspended" }), catalog: CATALOG }),
    ).toMatchObject({
      kind: "upgrade",
      reason: "paused",
      cta: "Pay for Plus",
      href: checkoutHref("plus"),
    });
  });

  it("an ended plan, no catalog: Choose a plan", () => {
    expect(
      decideOwnComputer({
        subscription: sub("plus", { plan_ended_at: "2026-10-01T00:00:00Z" }),
        catalog: null,
      }),
    ).toMatchObject({
      kind: "upgrade",
      reason: "ended",
      href: CHOOSE_PLAN_URL,
      cta: "Choose a plan",
    });
  });

  it("a console without limits: create", () => {
    expect(decideOwnComputer({ subscription: sub("mystery"), catalog: CATALOG })).toMatchObject({
      kind: "create",
    });
  });
});

describe("upgradePlanFor", () => {
  it("keeps Uno AI when the plan has it, skips legacy and the current plan", () => {
    const withAi = sub("plus-ai", {}, { running_ram_mb: 6 * 1024 });
    // Only Pro has more running room; no AI variant of it → Pro.
    expect(upgradePlanFor(CATALOG, withAi, "busy")?.slug).toBe("pro");
    const catalog = parsePlanCatalog({ plans: [wirePlan("mini", 10, 2, 4)] });
    expect(upgradePlanFor(catalog, null, "no_plan")).toBeNull();
    expect(parseAccountPlan(wirePlan("plus", 20, 4, 8))?.cloudWork).toBe(true);
  });
});

describe("describeOwnComputerFailure", () => {
  const ctx = { subscription: sub("plus"), catalog: CATALOG };
  const fail = (text: string) => describeOwnComputerFailure(new Error(text), ctx);

  it("plan refusals become the upgrade card", () => {
    expect(fail('Could not create the box: 409: {"error":"SHAPE_TOO_LARGE"}')).toMatchObject({
      kind: "upgrade",
      reason: "too_small",
    });
    expect(fail('409: {"error":"PEAK_EXCEEDED","message":"x"}')).toMatchObject({
      kind: "upgrade",
      reason: "busy",
      canTryAnyway: true,
    });
    expect(fail('404: {"error":"NO_SUBSCRIPTION"}')).toMatchObject({ reason: "no_plan" });
    expect(fail('403: {"error":"PLAN_WORK_ONLY"}')).toMatchObject({ reason: "too_small" });
    expect(fail('402: {"error":"PAYMENT_OVERDUE"}')).toMatchObject({ reason: "paused" });
    expect(fail('409: {"error":"DISK_QUOTA_EXCEEDED"}')).toMatchObject({ reason: "disk" });
    expect(fail('402: {"error":"INSUFFICIENT_BALANCE"}')).toMatchObject({
      reason: "balance",
      href: consoleLinks.addMoney,
    });
  });

  it("uses the console's own checkout link when it sent one", () => {
    const url = "https://console.uno.place/billing?tab=plan&plan=pro&checkout=1";
    expect(
      fail(`402: {"error":"PLAN_REQUIRED","reason":"plan_too_small","checkout_url":"${url}"}`),
    ).toMatchObject({ kind: "upgrade", href: url });
    // A link elsewhere is not followed.
    expect(
      fail(
        '402: {"error":"PLAN_REQUIRED","reason":"no_plan","checkout_url":"https://evil.example/x"}',
      ),
    ).toMatchObject({ href: checkoutHref("plus") });
  });

  it("other refusals are honest errors, raw text only in details", () => {
    expect(fail('409: {"error":"ASSISTANT_LIMIT"}')).toMatchObject({
      kind: "error",
      title: "Too many assistants",
    });
    expect(fail('409: {"error":"BUDGET_GUARD"}')).toMatchObject({ kind: "error" });
    expect(fail('400: {"error":"INVALID_COMPUTER_ROLE"}')).toMatchObject({
      kind: "error",
      title: "Not available on this account yet",
    });
    const other = fail("409: NO_NODE_CAPACITY");
    expect(other.kind).toBe("error");
    expect(other.title).not.toContain("409");
  });

  it("the 4 GB floor is Uno Work's", () => {
    expect(OWN_COMPUTER_SHAPE).toEqual({ ramMb: 4096, vcpu: 2, diskGb: 20 });
  });
});
