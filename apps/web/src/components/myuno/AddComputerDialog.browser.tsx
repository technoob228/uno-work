import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("../../hooks/useSwitchEnvironment", () => ({ useSwitchEnvironment: () => vi.fn() }));
vi.mock("../../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../CreateUnoBoxSection", () => ({ CreateUnoBoxSection: () => null }));

const { parseAccountComputer, parsePlanCatalog, parseSubscription } =
  await import("../../account/accountOverview");
const { AddComputerDialog } = await import("./AddComputerDialog");

/**
 * Plans "always on", stage 2: a new computer that doesn't fit in the
 * always-on memory. The console answers 409 PEAK_EXCEEDED with
 * `run_on_boosts`; the dialog offers the three ways out and "Run it on
 * boosts" asks again with `run_on_boosts: true`.
 *
 * VITE_BILLING_SHOT_DIR=/abs/dir saves a screenshot there.
 */

const gen2 = (slug: string, name: string, price: number, ramGb: number) => ({
  slug,
  name,
  price_usd: price,
  generation: 2,
  base_slug: slug,
  max_box: { ram_mb: ramGb * 1024, vcpu: ramGb },
  peak: { ram_mb: ramGb * 1024, vcpu: ramGb },
  always_on: { ram_mb: ramGb * 1024, vcpu: ramGb },
  boosts_per_month: 10,
});

const subscription = parseSubscription({
  plan: "plus",
  price_usd: 20,
  plan_limits: gen2("plus", "Plus", 20, 4),
  usage: { running_ram_mb: 4096, running_vcpu: 2 },
  plan_view: "always_on",
  always_on: { ram_mb: 4096, vcpu: 4, running_ram_mb: 4096, running_vcpu: 2 },
  boosts: { left: 23, per_month: 10, earned: 13, run_on_boosts: true },
});
const catalog = parsePlanCatalog({
  plans_v2: true,
  plans: [gen2("plus", "Plus", 20, 4), gen2("pro-v2", "Pro", 70, 16)],
});
const unoWork = parseAccountComputer({
  id: 1,
  name: "uno-work",
  status: "running",
  work_machine: true,
  ram_mb: 4096,
  vcpu: 2,
})!;

const PEAK = {
  error: "PEAK_EXCEEDED",
  message: "Your always-on 4 GB is in use.",
  always_on_ram_mb: 4096,
  running_ram_mb: 4096,
  need_ram_mb: 4096,
  run_on_boosts: {
    possible: true,
    boosts_left: 23,
    boosts_per_hour: 1,
    hours_about: 23,
    resets_at: "2026-11-01T00:00:00Z",
    reason: "",
  },
};

type Call = { method: string; path: string; body?: Record<string, unknown> };

function stubAccount(answer: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  (window as unknown as { desktopBridge: unknown }).desktopBridge = {
    unoAccount: {
      request: async (call: Call) => {
        calls.push(call);
        return answer(call);
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete (window as unknown as { desktopBridge?: unknown }).desktopBridge;
});

describe("Add computer past the always-on memory", () => {
  it("offers boosts, sleeping uno-work or Pro — and starts it on boosts", async () => {
    await page.viewport(900, 900);
    const calls = stubAccount((call) =>
      call.body?.["run_on_boosts"] === true
        ? { status: 201, body: { id: 9, name: "scraper", status: "provisioning" } }
        : { status: 409, body: PEAK },
    );
    const screen = await render(
      <QueryClientProvider client={new QueryClient()}>
        <AddComputerDialog
          open
          onOpenChange={() => {}}
          subscription={subscription}
          computers={[unoWork]}
          catalog={catalog}
          onSeePlans={() => {}}
        />
      </QueryClientProvider>,
    );
    await screen.getByTestId("add-computer-role-server").click();
    await screen.getByLabelText("Name").fill("scraper");
    await screen.getByRole("radio", { name: /4 GB · 2 cores/ }).click();
    await screen.getByRole("button", { name: "Create server" }).click();

    await expect.element(screen.getByText("Start “scraper” — 4 GB?")).toBeVisible();
    await expect.element(screen.getByText("Your always-on 4 GB is busy.")).toBeVisible();
    await expect
      .element(screen.getByTestId("run-past-plan-boosts"))
      .toHaveTextContent(
        "⚡ Run it on boosts1 boost an hour · you have 23, about a day. When they run out it sleeps; uno-work stays on.",
      );
    await expect
      .element(screen.getByTestId("run-past-plan-sleep"))
      .toHaveTextContent(/Put uno-work to sleep and start scraper instead/);
    await expect
      .element(screen.getByTestId("run-past-plan-plan"))
      .toHaveTextContent("Get Pro — always on 16 GB, $70/mo");
    const shotDir = import.meta.env.VITE_BILLING_SHOT_DIR as string | undefined;
    if (shotDir) await page.screenshot({ path: `${shotDir}/work-add-computer-on-boosts.png` });

    await screen.getByTestId("run-past-plan-go").click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/api/v1/work/servers",
      body: { name: "scraper", ram_mb: 4096, run_on_boosts: true },
    });
    expect(calls[0]!.body).not.toHaveProperty("run_on_boosts");
  });

  it("an older console (no run_on_boosts): the plain error, as before", async () => {
    stubAccount(() => ({ status: 409, body: { error: "PEAK_EXCEEDED" } }));
    const screen = await render(
      <QueryClientProvider client={new QueryClient()}>
        <AddComputerDialog
          open
          onOpenChange={() => {}}
          subscription={subscription}
          computers={[unoWork]}
          catalog={catalog}
          onSeePlans={() => {}}
        />
      </QueryClientProvider>,
    );
    await screen.getByTestId("add-computer-role-server").click();
    await screen.getByRole("button", { name: "Create server" }).click();
    await expect
      .element(screen.getByText(/Your plan is already running as much as it can at once/))
      .toBeVisible();
  });
});
