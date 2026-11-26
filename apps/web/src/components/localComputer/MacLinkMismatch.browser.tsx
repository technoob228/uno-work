import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const lifecycleOpenOwn = vi.hoisted(() => vi.fn());
let ownComputers: Array<{ id: string }> = [];

vi.mock("../../computersLifecycle/desktop", () => ({ useComputersLifecycleDesktop: () => true }));
vi.mock("../../computersLifecycle/useComputers", () => ({
  useOwnComputers: () => ({ hostId: null, computers: ownComputers, settled: true, enabled: true }),
}));
vi.mock("../computersLifecycle/WhereAgentsRun", () => ({
  useThisMacHelper: () => ({ installed: true, computerId: "7", name: "Mikhails-MacBook-Air" }),
}));
vi.mock("../../localComputer/localComputerStore", () => ({
  localComputer: { openConnect: lifecycleOpenOwn },
}));

import { MacLinkMismatch } from "./MacLinkMismatch";

afterEach(() => {
  ownComputers = [];
  lifecycleOpenOwn.mockClear();
});

describe("MacLinkMismatch", () => {
  it("says the Mac is on another account and reconnects through the connect flow", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(760, 120);
    const screen = await render(
      <div className="w-[720px] bg-background text-foreground">
        <MacLinkMismatch />
      </div>,
    );
    await expect.element(screen.getByTestId("mac-link-mismatch")).toBeVisible();
    await expect.element(screen.getByText(/connected to another Uno account/)).toBeVisible();
    await screen.getByTestId("mac-link-reconnect").click();
    expect(lifecycleOpenOwn).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when this Mac is among the account's computers", async () => {
    ownComputers = [{ id: "7" }];
    const screen = await render(<MacLinkMismatch />);
    expect(screen.container.querySelector("[data-testid=mac-link-mismatch]")).toBeNull();
  });
});
