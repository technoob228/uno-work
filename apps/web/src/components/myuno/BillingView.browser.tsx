import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  type AccountBalance,
  parsePlanCatalog,
  parseSubscription,
} from "../../account/accountOverview";
import { BillingView } from "./BillingView";
import { myUnoKeys } from "./myUnoQueries";

/**
 * Plan & billing on a plan "always on" (05.10): "Always on 4 GB", "Running
 * now · 3 of 4 GB", "⚡ Boosts · 23 left", plan cards with three numbers at
 * most — and an old plan ("hours") that keeps its screen.
 *
 * VITE_BILLING_SHOT_DIR=/abs/dir saves screenshots there.
 */

const gen2 = (slug: string, name: string, price: number, ramGb: number, boosts: number) => ({
  slug,
  name,
  price_usd: price,
  compute_price_usd: price,
  generation: 2,
  base_slug: slug.replace(/-ai$/, ""),
  max_box: { ram_mb: ramGb * 1024, vcpu: ramGb },
  peak: { ram_mb: ramGb * 1024, vcpu: ramGb },
  disk_gb: 40,
  s3_gb: 100,
  boost_hours: boosts,
  cloud_work: ramGb >= 4,
  always_on: { ram_mb: ramGb * 1024, vcpu: ramGb },
  boost_to: { ram_mb: ramGb * 2048, vcpu: ramGb * 2 },
  boosts_per_month: boosts,
  boost_unit_ram_mb: ramGb * 1024,
  ...(slug.endsWith("-ai")
    ? { ai_fast_unlimited: true, ai_hours_monthly: 40, ai_credits_usd: 0 }
    : {}),
});

const catalog = parsePlanCatalog({
  plans_v2: true,
  plans: [
    gen2("small", "Small", 5, 1, 5),
    gen2("small-ai", "Small", 15, 1, 5),
    gen2("plus", "Plus", 20, 4, 10),
    gen2("plus-ai", "Plus", 50, 4, 10),
    gen2("pro-v2", "Pro", 70, 16, 20),
    gen2("pro-v2-ai", "Pro", 120, 16, 20),
    gen2("max", "Max", 200, 48, 40),
    gen2("max-ai", "Max", 300, 48, 40),
  ],
});

const alwaysOnSub = parseSubscription({
  plan: "plus-ai",
  status: "active",
  price_usd: 50,
  next_billing_at: "2026-11-02T00:00:00Z",
  plan_limits: gen2("plus-ai", "Plus", 50, 4, 10),
  usage: { running_ram_mb: 3072, running_vcpu: 2, disk_gb_used: 20, box_count: 3 },
  ai_hours: { balance_minutes: 205, monthly_hours: 40, never_expire: true },
  plan_view: "always_on",
  always_on: {
    ram_mb: 4096,
    vcpu: 4,
    running_ram_mb: 3072,
    running_vcpu: 2,
    on_boosts_ram_mb: 0,
    computers: 3,
    computers_running: 1,
    computers_asleep: 2,
  },
  boosts: {
    left: 23,
    left_exact: 23.4,
    per_month: 10,
    earned: 13,
    used: 0.6,
    resets_at: "2026-11-01T00:00:00Z",
    earn: { enabled: true, per_sleep_hour: 1, monthly_cap: 20 },
    unit_ram_mb: 4096,
    burning_per_hour: 0,
    hours_left_at_this_rate: null,
    run_on_boosts: true,
  },
});

const balance: AccountBalance = {
  email: "misha@example.com",
  username: "misha",
  name: "Misha",
  balanceUsd: 30,
  aiBalanceUsd: 0,
  oneWallet: true,
  aiHoursMinutes: 205,
  onboardingPath: null,
  features: ["plan_always_on"],
};

function mount(subscription: ReturnType<typeof parseSubscription>) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(myUnoKeys.payments, []);
  return render(
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-5xl p-8">
        <BillingView
          subscription={subscription}
          subscriptionLoading={false}
          catalog={catalog}
          catalogLoading={false}
          balance={balance}
          cloud={{ usedBytes: 0, quotaBytes: 100 * 1024 ** 3, buckets: 0, bucketList: [] }}
          sites={undefined}
          computers={3}
        />
      </div>
    </QueryClientProvider>,
  );
}

const shotDir = import.meta.env.VITE_BILLING_SHOT_DIR as string | undefined;

describe("Plan & billing on a plan always on", () => {
  it("two numbers, no computer hours, cards with price · GB · boosts", async () => {
    await page.viewport(1280, 1500);
    const screen = await mount(alwaysOnSub);
    await expect.element(screen.getByTestId("my-uno-always-on")).toBeVisible();
    await expect.element(screen.getByText("Running now · 3 of 4 GB")).toBeVisible();
    await expect
      .element(screen.getByText("10 with your plan + 13 earned while asleep · new on Nov 1"))
      .toBeVisible();
    await expect
      .element(screen.getByText(/Need more than 4 GB\? Start another computer on boosts/))
      .toBeVisible();
    await expect
      .element(screen.getByTestId("my-uno-ai-fast"))
      .toHaveTextContent("Uno AI: Fast is unlimited. Smart comes in hours.");
    await expect.element(screen.getByText("⚡ 10 boosts a month").first()).toBeVisible();
    // The old usage list (and its hours) is not there.
    expect(screen.container.querySelector('[data-testid="my-uno-usage"]')).toBeNull();
    expect(screen.container.textContent).not.toMatch(/boost hours|computer hours/i);
    if (shotDir) await page.screenshot({ path: `${shotDir}/work-myuno-billing.png` });
  });

  it("an old plan keeps its screen", async () => {
    const old = parseSubscription({
      plan: "builder",
      status: "active",
      price_usd: 22,
      plan_limits: {
        slug: "builder",
        name: "Builder",
        price_usd: 22,
        max_box: { ram_mb: 4096, vcpu: 2 },
        peak: { ram_mb: 8192, vcpu: 4 },
        disk_gb: 40,
        boost_hours: 10,
        legacy: true,
      },
      usage: { running_ram_mb: 4096, running_vcpu: 2, disk_gb_used: 10, box_count: 1 },
      plan_view: "hours",
    });
    const screen = await mount(old);
    await expect.element(screen.getByTestId("my-uno-usage")).toBeVisible();
    expect(screen.container.querySelector('[data-testid="my-uno-always-on"]')).toBeNull();
    await expect.element(screen.getByText("10 boost hours a month").first()).toBeVisible();
  });
});
