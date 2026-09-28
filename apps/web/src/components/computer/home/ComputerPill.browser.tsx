import "../../../index.css";

import type { EnvironmentId, UnoComputerState } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ComputerSwitcher } from "../../computerSwitcher/useComputerSwitcher";

const openMachine = vi.fn();
const openAddComputer = vi.fn();

const switcher = {
  environments: [],
  groups: [
    {
      kind: "uno_box",
      label: "Cloud computers",
      items: [
        {
          id: "env-work" as EnvironmentId,
          name: "uno-work",
          meta: "Linux x64",
          kind: "uno_box",
          connectionState: "connected",
          isPrimary: true,
          isDefault: false,
        },
        {
          id: "env-lab" as EnvironmentId,
          name: "lab-box",
          meta: "Synced · Linux x64",
          kind: "uno_box",
          connectionState: "connected",
          isPrimary: false,
          isDefault: false,
        },
      ],
    },
  ],
  current: null,
  currentId: "env-work" as EnvironmentId,
  accountBoxes: [],
  connecting: null,
  openMachine,
  openAccountBox: vi.fn(),
  toggleDefault: vi.fn(),
  canReconnectCurrent: false,
  isReconnectingCurrent: false,
  reconnectCurrentEnvironment: vi.fn(),
  unlinkedLocalDaemon: null,
  useThisComputer: { isBusy: false, phase: { kind: "idle" }, run: vi.fn() },
  addEnvOpen: false,
  setAddEnvOpen: vi.fn(),
  openAddComputer,
  goAllComputers: vi.fn(),
} as unknown as ComputerSwitcher;

vi.mock("../../computerSwitcher/useComputerSwitcher", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useComputerSwitcher: () => switcher,
}));
vi.mock("../../computerSwitcher/ComputerSwitcherList", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ComputerSwitcherDialogs: () => null,
}));

const { ComputerPill } = await import("./ComputerPill");
const { EconomyLine } = await import("../EconomyControl");
const { computerQueryKeys } = await import("../computerQueries");

/** Economy and boost as the console sends them, for the real `EconomyLine`. */
function seededClient() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(computerQueryKeys.state(null, null), {
    linked: true,
    box: {
      economy: {
        enabled: true,
        locked: false,
        source: "default",
        idleTimeoutS: 600,
        defaultIdleTimeoutS: 600,
        state: "awake",
        sleepAfter: null,
        busy: ["clients:1"],
        lastSleepAt: null,
        lastWakeAt: null,
        lastWakeSource: null,
      },
      boost: {
        hoursPerMonth: 5,
        hoursLeft: 7,
        hoursEarnedEconomy: 1.8,
        economyEarn: { enabled: true, hoursPerSleepHour: 0.1, monthlyCapHours: 10 },
      },
    },
  } as unknown as UnoComputerState);
  return client;
}

describe("ComputerPill — the one computer menu", () => {
  it("shows this computer, a quiet economy and boost line, and the computers to switch to", async () => {
    await page.viewport(1100, 820);
    render(
      <QueryClientProvider client={seededClient()}>
        <div className="flex justify-end p-4">
          <ComputerPill
            loading={false}
            computer={{
              name: "uno-work",
              subtitle: "4 GB · 2 cores · awake 3 h",
              status: "running",
              address: "https://uno-work.uno4.dev",
              load: {
                cpuPct: 12,
                memUsedMb: 1400,
                memTotalMb: 4096,
                diskUsedGb: 9,
                diskTotalGb: 20,
              },
              boosted: false,
              boost: null,
              power: null,
              onOpenLook: () => undefined,
              economyOn: true,
              economy: <EconomyLine environmentId={null} boxId={null} />,
              boostSummary: "Boost: 7 h left this month (+1.8 h earned by economy)",
            }}
          />
        </div>
      </QueryClientProvider>,
    );
    await expect.element(page.getByLabelText("Economy on")).toBeInTheDocument();
    await page.getByTestId("home-computer-pill").click();
    await expect.element(page.getByText(/Economy: on · sleeps after 10 min/)).toBeVisible();
    await expect.element(page.getByText(/\+1\.8 h earned by economy/)).toBeVisible();
    await expect.element(page.getByText("lab-box")).toBeVisible();
    await expect.element(page.getByText("Add computer")).toBeVisible();
    // Not "All my computers" twice: the switcher carries it.
    expect(page.getByText("All my computers").elements()).toHaveLength(0);
    if (import.meta.env.VITE_PILL_SCREENSHOT) {
      await page.screenshot({ path: "computer-menu.png" });
    }
    // "How it works" unfolds the explanation, including what sleeping earns.
    await page.getByRole("button", { name: "How economy works" }).click();
    await expect
      .element(page.getByText(/Every 10 hours asleep earn you 1 extra Boost hour/))
      .toBeVisible();
    if (import.meta.env.VITE_PILL_SCREENSHOT) {
      await page.screenshot({ path: "computer-menu-economy-open.png" });
    }
    await page.getByText("lab-box").click();
    expect(openMachine).toHaveBeenCalledWith("env-lab", "uno_box");
  });

  it("still switches computers when this one can't be read", async () => {
    render(<ComputerPill loading={false} computer={null} />);
    await page.getByTestId("home-computer-pill").click();
    await page.getByText("Add computer").click();
    expect(openAddComputer).toHaveBeenCalled();
  });
});
