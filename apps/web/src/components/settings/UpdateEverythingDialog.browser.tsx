import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { SelfUpdateStatus } from "../../selfUpdate/selfUpdate";
import {
  buildUpdatePlan,
  isUpdatableBox,
  type PlanRow,
  type RunDeps,
  type UpdateTarget,
} from "../../updateEverything/updateEverything.logic";

/**
 * The Update button and "Update everything" in a real browser, on an account
 * shaped like the one from 24.11 (Misha: "a list of 20, everything hangs,
 * nothing updated"): 28 boxes, 16 of them archived, six plain servers, five
 * Uno Work computers of which one serves this page.
 *
 * Before 0.0.193 the same account got every box (28 rows) and the run could
 * wait forever on one that never woke. VITE_UPDATE_SHOTS=<dir> also writes the
 * screenshots for the report.
 */

const shotDir = import.meta.env.VITE_UPDATE_SHOTS as string | undefined;

const status = (input: Partial<SelfUpdateStatus>): SelfUpdateStatus => ({
  supported: true,
  canUpdate: true,
  currentVersion: "0.0.191",
  latestVersion: "0.0.192",
  available: true,
  state: "idle",
  step: null,
  error: null,
  fromVersion: null,
  toVersion: null,
  rolledBack: false,
  startedAt: null,
  finishedAt: null,
  ...input,
});

interface Box {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly workMachine: boolean;
}

const ARCHIVED = [3811, 3269, 2520, 2385, 1924, 1725, 1724, 1723, 1722, 1721, 1177, 1019, 129, 76];
const BOXES: ReadonlyArray<Box> = [
  { id: 20094, name: "cloud-build-csdk-stall-1119", status: "running", workMachine: false },
  { id: 19480, name: "cloud-build-data-1119", status: "running", workMachine: false },
  { id: 19478, name: "cloud-build-engine-1119", status: "running", workMachine: false },
  { id: 9363, name: "mover-e2e-laptop", status: "running", workMachine: false },
  { id: 9360, name: "mover-e2e-ssh", status: "running", workMachine: false },
  { id: 6777, name: "network-test-exit", status: "running", workMachine: false },
  { id: 3273, name: "kinship", status: "sleeping", workMachine: true },
  { id: 2539, name: "work-build", status: "running", workMachine: false },
  { id: 2534, name: "work-canary", status: "running", workMachine: true },
  { id: 2531, name: "stage-work", status: "sleeping", workMachine: true },
  { id: 2292, name: "kaiki-sandbox", status: "running", workMachine: true },
  ...ARCHIVED.map((id) => ({ id, name: `box-${id}`, status: "archived", workMachine: false })),
  { id: 46, name: "box-46", status: "archived", workMachine: false },
  { id: 44, name: "box-44", status: "archived", workMachine: false },
];

const PRIMARY: UpdateTarget = {
  key: "env:uno-work",
  label: "uno-work",
  environmentId: "env-uno-work",
  boxId: 395,
  isPrimary: true,
  reach: "online",
  selfUpdate: status({}),
  agents: [],
  runningChats: 0,
};

const boxTarget = (box: Box): UpdateTarget => ({
  key: `box:${box.id}`,
  label: box.name,
  environmentId: null,
  boxId: box.id,
  isPrimary: false,
  // Not connected from this page: "asleep" whatever the power state says.
  reach: "asleep",
  selfUpdate: null,
  agents: null,
  runningChats: 0,
});

/** After: the hook's filter (useUpdateEverything) on the same account. */
const rowsAfter = buildUpdatePlan([
  PRIMARY,
  ...BOXES.filter((box) => isUpdatableBox(box)).map(boxTarget),
]);

const never = <T,>() => new Promise<T>(() => {});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let fixture: {
  rows: ReadonlyArray<PlanRow>;
  runDeps: Omit<RunDeps, "onProgress" | "updateWork"> & {
    updateWork: (environmentId: string, when: string) => Promise<"updated" | "waiting">;
  };
} = {
  rows: rowsAfter,
  runDeps: {
    wake: () => never(),
    updateAgent: async () => {},
    updateWork: async () => {
      await sleep(400);
      return "updated";
    },
    readVersion: async () => "0.0.192",
  },
};

const hook = () => ({
  rows: fixture.rows,
  app: null,
  runDeps: fixture.runDeps,
  updateApp: async () => {},
  checking: false,
});

vi.mock("../../updateEverything/useUpdateEverything", () => ({ useUpdateEverything: hook }));
// No page reload after "this computer" updated: it would end the test.
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isElectron: true,
}));

const { UpdateEverythingDialog } = await import("../../updateEverything/UpdateEverythingDialog");

async function shot(name: string) {
  if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png` });
}

describe("Update (24.11)", () => {
  it("Update is about this computer: one row, one click", async () => {
    await page.viewport(900, 700);
    fixture = { ...fixture, rows: rowsAfter };
    const screen = await render(
      <UpdateEverythingDialog
        open
        onOpenChange={() => {}}
        focusEnvironmentId={"env-uno-work" as never}
      />,
    );
    await expect.element(page.getByRole("heading", { name: "Update Uno Work" })).toBeVisible();
    expect(page.getByTestId("update-everything-row").elements()).toHaveLength(1);
    await expect.element(page.getByText("Uno Work 0.0.192")).toBeVisible();
    await shot("after-1-update-this-computer");

    await userEvent.click(page.getByTestId("self-update-confirm"));
    await expect.element(page.getByText("Updated · Uno Work 0.0.192")).toBeVisible();
    await shot("after-2-done-real-version");
    await userEvent.click(page.getByText("Close", { exact: true }));
    await screen.unmount();
  });

  it("Update everything: only Work computers, sleeping ones unticked", async () => {
    await page.viewport(900, 900);
    fixture = { ...fixture, rows: rowsAfter };
    const screen = await render(
      <UpdateEverythingDialog
        open
        onOpenChange={() => {}}
        focusEnvironmentId={"env-uno-work" as never}
      />,
    );
    await userEvent.click(page.getByTestId("update-everything-others"));
    await expect.element(page.getByRole("heading", { name: "Update everything" })).toBeVisible();
    // 1 + kinship, work-canary, stage-work, kaiki-sandbox; no archived, no servers.
    expect(page.getByTestId("update-everything-row").elements()).toHaveLength(5);
    expect(page.getByText("box-3811").elements()).toHaveLength(0);
    expect(page.getByText("work-build").elements()).toHaveLength(0);
    await expect.element(page.getByText("Update 1 item")).toBeVisible();
    await shot("after-3-everything-list");

    // Ticking a sleeping one: it wakes for this, and a computer that never
    // wakes fails its own row (here quickly; for real after 3 min).
    await userEvent.click(page.getByRole("checkbox", { name: "Update kinship" }));
    await expect
      .element(page.getByText("Not open here now. Wakes up or connects to update"))
      .toBeVisible();
    await expect.element(page.getByText("Update 2 items")).toBeVisible();
    await shot("after-4-ticked-asleep");
    fixture = {
      ...fixture,
      runDeps: {
        ...fixture.runDeps,
        wake: async () => {
          await sleep(300);
          throw new Error("Didn't wake up in 3 min. Update it when you open it.");
        },
      },
    };
    await screen.unmount();
    const again = await render(<UpdateEverythingDialog open onOpenChange={() => {}} />);
    await userEvent.click(page.getByRole("checkbox", { name: "Update kinship" }));
    await userEvent.click(page.getByText("Update 2 items"));
    await expect.element(page.getByText("1 updated · 1 not updated, see why above")).toBeVisible();
    await expect.element(page.getByRole("heading", { name: "Update everything" })).toBeVisible();
    await shot("after-5-result-per-computer");
    await again.unmount();
  });
});
