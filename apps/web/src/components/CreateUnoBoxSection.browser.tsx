import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { CreateUnoBoxSection } from "./CreateUnoBoxSection";

/**
 * "Create a new computer" within the plan (icp3 09.10, h1/17): 2 / 4 / 8 GB,
 * what the plan leaves, sizes past it disabled with the reason and "Change
 * plan", and one honest line about what it costs.
 *
 * VITE_NEW_COMPUTER_SHOT_DIR=/abs/dir saves screenshots there.
 */

const plus = (runningMb: number) => ({
  plan: "plus",
  status: "active",
  price_usd: 20,
  plan_limits: {
    slug: "plus",
    name: "Plus",
    price_usd: 20,
    generation: 2,
    base_slug: "plus",
    max_box: { ram_mb: 4096, vcpu: 4 },
    peak: { ram_mb: 4096, vcpu: 4 },
    always_on: { ram_mb: 4096, vcpu: 4 },
    disk_gb: 40,
  },
  usage: { running_ram_mb: runningMb, running_vcpu: 2, disk_gb_used: 20, box_count: 1 },
  plan_view: "always_on",
  always_on: { ram_mb: 4096, vcpu: 4, running_ram_mb: runningMb, running_vcpu: 2 },
});

function stubAccount(subscription: unknown) {
  (window as unknown as { desktopBridge: unknown }).desktopBridge = {
    unoAccount: {
      request: async (call: { path: string }) =>
        call.path.startsWith("/api/v1/box-subscription")
          ? { status: 200, body: subscription }
          : { status: 404, body: { error: "NOT_FOUND" } },
    },
  };
}

afterEach(() => {
  delete (window as unknown as { desktopBridge?: unknown }).desktopBridge;
});

async function show(subscription: unknown) {
  stubAccount(subscription);
  await page.viewport(560, 520);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <div className="w-[520px] p-5">
        <h3 className="mb-3 font-medium text-foreground text-sm">Create a new computer</h3>
        <CreateUnoBoxSection environmentId={null} defaultName="work-2" onCreated={() => {}} />
      </div>
    </QueryClientProvider>,
  );
}

const shotDir = import.meta.env.VITE_NEW_COMPUTER_SHOT_DIR as string | undefined;

describe("Create a new computer within the plan", () => {
  it("Plus with 2 GB running: 2 GB fits and is picked, 4 GB has no room, 8 GB is over the plan", async () => {
    const screen = await show(plus(2048));
    await expect
      .element(screen.getByTestId("new-computer-plan-room"))
      .toHaveTextContent("Your Plus: 4 GB for computers, 2 GB in use — 2 GB left.");
    await expect.element(screen.getByTestId("new-computer-size-2048")).toBeEnabled();
    await expect
      .element(screen.getByTestId("new-computer-size-2048"))
      .toHaveAttribute("aria-checked", "true");
    await expect.element(screen.getByTestId("new-computer-size-4096")).toBeDisabled();
    await expect
      .element(screen.getByTestId("new-computer-size-4096"))
      .toHaveTextContent("Only 2 GB left");
    await expect.element(screen.getByTestId("new-computer-size-8192")).toBeDisabled();
    await expect
      .element(screen.getByTestId("new-computer-size-8192"))
      .toHaveTextContent("Plan max 4 GB");
    await expect
      .element(screen.getByTestId("new-computer-cost"))
      .toHaveTextContent("Included in Plus — nothing extra to pay.");
    if (shotDir) await page.screenshot({ path: `${shotDir}/02-after-create-form-plus.png` });
  });

  it("nothing fits: says why, offers Change plan, the button is off", async () => {
    const screen = await show(plus(4096));
    await expect
      .element(screen.getByTestId("new-computer-cost"))
      .toHaveTextContent(
        "4 GB of your 4 GB is running now. Put a computer to sleep, or change plan. Change plan",
      );
    await expect.element(screen.getByRole("button", { name: /Create computer/ })).toBeDisabled();
    if (shotDir) await page.screenshot({ path: `${shotDir}/03-after-create-form-full.png` });
  });
});
