import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { parseAccountComputer } from "../../account/accountOverview";
import { ComputersTab } from "./ComputersTab";
import { computerEntry, localEntry } from "./myUnoModel";
import type { ComputerActions } from "./useComputerActions";

/**
 * "Open in console" on a computer's row in My Uno (0.0.106): one click from
 * the list to the computer's page in the Uno console (Access, SSH keys,
 * networking), without opening the side panel.
 */

const actions = {
  pending: () => null,
  restarting: () => false,
  bringBack: vi.fn(),
} as unknown as ComputerActions;

function box(raw: Record<string, unknown>) {
  const parsed = parseAccountComputer({ ram_mb: 2048, vcpu: 1, disk_gb: 10, ...raw });
  if (!parsed) throw new Error("bad fixture");
  return parsed;
}

afterEach(() => vi.restoreAllMocks());

describe("My Uno: open a computer in the console", () => {
  it("opens the console page of that computer and leaves the row alone", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const onSelect = vi.fn();
    const screen = await render(
      <ComputersTab
        entries={[
          computerEntry(
            box({ id: 2321, name: "desk", status: "running", work_machine: true }),
            [],
            true,
          ),
          computerEntry(
            box({ id: 77, name: "shop-db", status: "running", computer_role: "server" }),
            [],
            false,
          ),
        ]}
        loading={false}
        error={null}
        subscription={null}
        selectedKey={null}
        onSelect={onSelect}
        onOpen={vi.fn()}
        opening={null}
        actions={actions}
        onAdd={vi.fn()}
      />,
    );
    const buttons = screen.getByTestId("my-uno-open-console");
    await expect.element(buttons.first()).toBeInTheDocument();
    expect(buttons.elements()).toHaveLength(2);
    await screen
      .getByRole("button", { name: "Open shop-db in the console" })
      .click({ force: true });
    expect(opened).toHaveBeenCalledWith(
      "https://console.uno4.dev/boxes/77",
      "_blank",
      "noopener,noreferrer",
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("has no console button for a computer that isn't in the Uno cloud", async () => {
    const screen = await render(
      <ComputersTab
        entries={[localEntry("My Mac", true)]}
        loading={false}
        error={null}
        subscription={null}
        selectedKey={null}
        onSelect={vi.fn()}
        onOpen={vi.fn()}
        opening={null}
        actions={actions}
        onAdd={vi.fn()}
      />,
    );
    await expect.element(screen.getByTestId("my-uno-computers")).toBeInTheDocument();
    expect(screen.getByTestId("my-uno-open-console").query()).toBeNull();
  });
});
