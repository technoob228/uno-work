import "../../index.css";

import type { UnoComputerSizing } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { HomeComputer } from "./home/ComputerPill";

// The menu around the details asks the switcher and the local daemon; not under test here.
vi.mock("../localComputer/LocalComputerConnector", () => ({ LocalComputerMenuItems: () => null }));
vi.mock("../computerSwitcher/useComputerSwitcher", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useComputerSwitcher: () => null,
}));
vi.mock("../computerSwitcher/ComputerSwitcherList", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ComputerSwitcherDialogs: () => null,
}));

const { ComputerDetails } = await import("./home/ComputerPill");

const minsAgo = (m: number) => new Date(Date.now() - m * 60000).toISOString();

const sizing: UnoComputerSizing = {
  mode: "auto",
  cpu: { current: 6, base: 2, max: 8 },
  memoryMb: { current: 6144, base: 2048, max: 8192 },
  diskGb: { current: 40, base: 40, max: 40 },
  history: [
    {
      seq: 3,
      at: minsAgo(190),
      resource: "cpu",
      from: 2,
      to: 4,
      reason: "pressure",
      applied: true,
    },
    {
      seq: 4,
      at: minsAgo(188),
      resource: "memory",
      from: 2048,
      to: 4096,
      reason: "pressure",
      applied: true,
    },
    { seq: 5, at: minsAgo(150), resource: "cpu", from: 4, to: 3, reason: "idle", applied: true },
    { seq: 6, at: minsAgo(42), resource: "cpu", from: 3, to: 6, reason: "pressure", applied: true },
    {
      seq: 7,
      at: minsAgo(41),
      resource: "memory",
      from: 4096,
      to: 6144,
      reason: "pressure",
      applied: true,
    },
  ],
};

const computer = (s: UnoComputerSizing | null): HomeComputer => ({
  name: "my-work",
  subtitle: "2 GB · 2 cores · 40 GB · awake 3 h",
  status: "running",
  address: null,
  load: { cpuPct: 71, memUsedMb: 4900, memTotalMb: 6144, diskUsedGb: 9, diskTotalGb: 40 },
  boosted: false,
  boost: null,
  power: null,
  sizing: s,
});

const shotDir = import.meta.env.VITE_SIZING_SHOTS as string | undefined;

describe("Automatic sizing in the computer menu", () => {
  it("one quiet line with the size now; a click opens the card", async () => {
    await page.viewport(900, 820);
    render(
      <div className="w-80 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg">
        <ComputerDetails computer={computer(sizing)} />
      </div>,
    );
    const line = page.getByTestId("computer-sizing-line");
    await expect.element(line).toHaveTextContent("Automatic sizing · 6 cores · 6 GB");
    if (shotDir) await page.screenshot({ path: `${shotDir}/work-1-menu.png` });
    await line.click();
    const dialog = page.getByTestId("computer-sizing-dialog");
    await expect.element(dialog).toHaveTextContent("base 2 · up to 8");
    await expect.element(dialog).toHaveTextContent("Memory 4 GB → 6 GB");
    await new Promise((r) => setTimeout(r, 600));
    if (shotDir) await page.screenshot({ path: `${shotDir}/work-2-card.png` });
  });

  it("nothing for a computer without it", async () => {
    render(
      <div className="w-80 p-3">
        <ComputerDetails computer={computer(null)} />
      </div>,
    );
    expect(page.getByTestId("computer-sizing-line").elements()).toHaveLength(0);
  });

  it("the server had no room: said in amber, nothing else changes", async () => {
    await page.viewport(900, 820);
    render(
      <div className="w-80 rounded-xl border bg-popover p-3 shadow-lg">
        <ComputerDetails
          computer={computer({
            ...sizing,
            cpu: { current: 2, base: 2, max: 8 },
            memoryMb: { current: 4096, base: 2048, max: 8192 },
            history: [
              {
                seq: 2,
                at: minsAgo(12),
                resource: "memory",
                from: 2048,
                to: 4096,
                reason: "pressure",
                applied: true,
              },
              {
                seq: 3,
                at: minsAgo(3),
                resource: "memory",
                from: 4096,
                to: 4096,
                reason: "node_limit",
                applied: false,
              },
            ],
          })}
        />
      </div>,
    );
    await page.getByTestId("computer-sizing-line").click();
    await expect
      .element(page.getByTestId("computer-sizing-dialog"))
      .toHaveTextContent("the server is busy");
    await new Promise((r) => setTimeout(r, 600));
    if (shotDir) await page.screenshot({ path: `${shotDir}/work-3-node-limit.png` });
  });
});
