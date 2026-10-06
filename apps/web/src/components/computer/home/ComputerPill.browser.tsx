import "../../../index.css";

import type { EnvironmentId, UnoComputerState } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
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
const { CONNECTED, describeConnection } = await import("./connectionStatus");
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
        // The rule as it is in prod (05.10): 1 boost hour per hour asleep, up to 20 a month.
        economyEarn: { enabled: true, hoursPerSleepHour: 1, monthlyCapHours: 20 },
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
    // The simple start screen (no Dev mode): name, on/asleep and "Details" —
    // no meters or economy/boost marks on the pill; it's all in the menu.
    await expect.element(page.getByText("Details")).toBeInTheDocument();
    expect(page.getByLabelText("Economy on").elements()).toHaveLength(0);
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
      .element(
        page.getByText(/Every hour asleep earns you 1 extra Boost hour \(up to 20 h a month\)/),
      )
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

  describe("in the chat header (fit=chat)", () => {
    const chip = (width: number) => (
      <div className="@container/header-actions flex justify-end p-2" style={{ width }}>
        <ComputerPill
          loading={false}
          fit="chat"
          computer={{
            name: "uno-work",
            subtitle: null,
            status: "running",
            address: null,
            load: { cpuPct: 12, memUsedMb: 1400, memTotalMb: 4096, diskUsedGb: 9, diskTotalGb: 20 },
            boosted: false,
            boost: null,
            power: null,
          }}
        />
        <button type="button">after</button>
      </div>
    );

    it("folds to an icon and the dot when the header is narrow, and opens from the keyboard", async () => {
      await page.viewport(1100, 820);
      render(chip(420));
      const trigger = page.getByTestId("chat-computer-chip");
      await expect.element(trigger).toHaveAccessibleName("uno-work — computer menu");
      await expect.element(trigger.getByText("uno-work")).not.toBeVisible();
      expect((trigger.element() as HTMLElement).getBoundingClientRect().width).toBeLessThan(48);
      if (import.meta.env.VITE_PILL_SCREENSHOT) {
        await page.screenshot({ path: "chat-chip-narrow.png" });
      }
      (trigger.element() as HTMLElement).focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByText("lab-box")).toBeVisible();
      await expect.element(page.getByText("Add computer")).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByText("Add computer")).not.toBeInTheDocument();
      await expect.element(trigger).toHaveFocus();
    });

    it("shows the name, and the meters in a roomy header", async () => {
      await page.viewport(1400, 820);
      render(chip(1300));
      const trigger = page.getByTestId("chat-computer-chip");
      await expect.element(trigger.getByText("uno-work")).toBeVisible();
      await expect.element(trigger.getByText("CPU")).toBeVisible();
      if (import.meta.env.VITE_PILL_SCREENSHOT) {
        await page.screenshot({ path: "chat-chip-wide.png" });
      }
    });
  });

  describe("the connection, said quietly (no toasts)", () => {
    const NOW = Date.parse("2026-10-05T12:00:00Z");
    const conn = (
      overrides: Partial<Parameters<typeof describeConnection>[0]> = {},
      act: (() => void) | null = null,
    ) => ({
      status: describeConnection({
        link: "down",
        downSince: NOW,
        networkOnline: true,
        economy: null,
        signInNeeded: false,
        now: NOW,
        ...overrides,
      }),
      act,
      acting: false,
    });
    const computer = {
      name: "uno-work",
      subtitle: "4 GB · 2 cores · awake 3 h",
      status: "running",
      address: null,
      load: { cpuPct: 12, memUsedMb: 1400, memTotalMb: 4096, diskUsedGb: 9, diskTotalGb: 20 },
      boosted: false,
      boost: null,
      power: null,
    };
    const shotDir = import.meta.env.VITE_CONNECTION_SHOTS as string | undefined;
    const scenes = [
      { title: "Connected", connection: { status: CONNECTED, act: null, acting: false } },
      { title: "Drop under 5 s", connection: conn({ downSince: NOW - 2_000 }) },
      { title: "Reconnecting", connection: conn({ downSince: NOW - 12_000 }) },
      { title: "Over a minute", connection: conn({ downSince: NOW - 2 * 60_000 }, () => {}) },
      { title: "Over 3 minutes", connection: conn({ downSince: NOW - 5 * 60_000 }, () => {}) },
      { title: "No network", connection: conn({ downSince: NOW - 30_000, networkOnline: false }) },
      { title: "Economy asleep", connection: conn({ economy: "sleeping" }, () => {}) },
      { title: "Economy waking", connection: conn({ economy: "waking" }) },
    ];

    it("keeps the chip as it was for a short drop, then says it in place of On", async () => {
      await page.viewport(900, 760);
      render(
        <QueryClientProvider client={new QueryClient()}>
          <div className="flex flex-col gap-3 p-6">
            {scenes.map((scene) => (
              <div key={scene.title} className="flex items-center gap-4">
                <span className="w-36 text-xs text-muted-foreground">{scene.title}</span>
                <div data-scene={scene.title}>
                  <ComputerPill loading={false} computer={computer} connection={scene.connection} />
                </div>
                <span className="text-xs text-muted-foreground">
                  menu: {scene.connection.status.line}
                </span>
              </div>
            ))}
          </div>
        </QueryClientProvider>,
      );
      await expect.element(page.getByText("Waking…")).toBeVisible();
      const chips = page.getByTestId("computer-connection-chip");
      // Connected and a drop under 5 s say nothing: "On · Details" as before.
      expect(chips.elements().map((element) => element.textContent)).toEqual([
        "Reconnecting…",
        "Offline — retrying",
        "No connection",
        "Offline",
        "Asleep",
        "Waking…",
      ]);
      expect(page.getByText("On", { exact: true }).elements()).toHaveLength(2);
      if (shotDir) await page.screenshot({ path: `${shotDir}/after-1-home-chip-states.png` });
    });

    it("the menu's first line is the truth, with the one action when the person is needed", async () => {
      await page.viewport(900, 760);
      const retry = vi.fn();
      render(
        <QueryClientProvider client={new QueryClient()}>
          <div className="flex justify-end p-4">
            <ComputerPill
              loading={false}
              computer={computer}
              connection={conn({ downSince: NOW - 5 * 60_000 }, retry)}
            />
          </div>
        </QueryClientProvider>,
      );
      await page.getByTestId("home-computer-pill").click();
      const line = page.getByTestId("computer-connection-line");
      await expect.element(line).toHaveTextContent("Can't reach this computer · synced 5 min ago");
      if (shotDir) await page.screenshot({ path: `${shotDir}/after-2-menu-no-connection.png` });
      await line.getByRole("button", { name: "Retry" }).click();
      expect(retry).toHaveBeenCalled();
    });

    it("folded in a narrow chat header, only what needs the person speaks", async () => {
      await page.viewport(900, 400);
      render(
        <div className="flex flex-col gap-3 p-4">
          {[
            { key: "reconnecting", connection: conn({ downSince: NOW - 12_000 }) },
            { key: "lost", connection: conn({ downSince: NOW - 5 * 60_000 }, () => {}) },
          ].map(({ key, connection }) => (
            <div
              key={key}
              className="@container/header-actions flex justify-end gap-2 border-b p-2"
              style={{ width: 420 }}
            >
              <ComputerPill
                loading={false}
                fit="chat"
                computer={computer}
                connection={connection}
              />
              <button type="button">after</button>
            </div>
          ))}
        </div>,
      );
      const chips = page.getByTestId("computer-connection-chip");
      await expect.element(chips.nth(0)).not.toBeVisible();
      await expect.element(chips.nth(1)).toBeVisible();
      await expect
        .element(page.getByTestId("chat-computer-chip").nth(1))
        .toHaveAccessibleName("uno-work — No connection, computer menu");
      if (shotDir) await page.screenshot({ path: `${shotDir}/after-3-chat-chip-narrow.png` });
    });
  });
});
