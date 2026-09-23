import "../../index.css";

import type { UnoComputerInstalledApp, UnoMachineApp } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProgramDialog } from "./ProgramDialog";
import { buildProgramTiles, type RemovalCloudFiles } from "./programModel";

const memos: UnoComputerInstalledApp = {
  key: "service:-77",
  name: "Memos",
  templateId: "memos",
  icon: "📝",
  state: "running",
  url: "https://memos-my-computer.app.uno4.dev",
  deploymentId: 77,
  notes: null,
  credentials: [
    { label: "Login", value: "owner", secret: false, link: false },
    { label: "Password", value: "k2-violet-harbor", secret: true, link: false },
  ],
  removable: true,
  webPort: 5230,
  composeProject: "uno-memos",
  aiKey: { limitUsd: 10, spentUsd: 0.12 },
};

const myBot: UnoMachineApp = {
  id: "docker:my-bot",
  source: "docker",
  name: "my-bot",
  description: null,
  icon: "🐳",
  iconImage: null,
  status: "running",
  port: 7000,
  udpPorts: [],
  http: false,
  loopbackOnly: false,
  detail: "Docker · me/my-bot",
  url: null,
  localUrl: null,
  publication: null,
  canStart: false,
  canStop: true,
  canRemove: true,
  composeProject: "bots",
};

function tileFor(storeApps: UnoComputerInstalledApp[], machineApps: UnoMachineApp[]) {
  return buildProgramTiles({
    machineApps,
    storeApps,
    installs: [],
    browserOnMachine: false,
    computerOn: true,
  })[0]!;
}

function renderDialog(input: {
  tile: ReturnType<typeof tileFor>;
  pending?: boolean;
  onRemove?: (...args: unknown[]) => void;
  cloudFiles?: RemovalCloudFiles | null;
  onSave?: (deploymentId: number, limit: number | null) => Promise<unknown>;
}) {
  return render(
    <ProgramDialog
      tile={input.tile}
      machineApps={undefined}
      browserOnMachine={false}
      pendingAction={null}
      actionError={null}
      onAction={() => undefined}
      onClose={() => undefined}
      remove={{
        pending: input.pending ?? false,
        error: null,
        onRemove: input.onRemove ?? (() => undefined),
        onReset: () => undefined,
        cloudFiles: () => input.cloudFiles ?? null,
      }}
      aiLimit={{
        pending: false,
        error: null,
        onSave: input.onSave ?? (async () => undefined),
      }}
    />,
  );
}

describe("ProgramDialog — Remove and AI limit", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("removes an App Store app, keeping its data unless the box is ticked", async () => {
    const onRemove = vi.fn();
    const screen = await renderDialog({ tile: tileFor([memos], []), onRemove });
    try {
      await expect
        .element(page.getByText("If you changed the password inside the app, use your new one."))
        .toBeInTheDocument();
      await expect.element(page.getByText("of $10 limit")).toBeInTheDocument();

      await page.getByRole("button", { name: "Remove" }).click();
      await expect.element(page.getByText("Remove Memos?")).toBeInTheDocument();
      await expect
        .element(page.getByText(/Memos will stop and disappear from this computer/))
        .toBeInTheDocument();

      await page.getByRole("checkbox", { name: /Also delete Memos's data/ }).click();
      const confirm = page.getByRole("button", { name: "Remove and delete data" });
      await expect.element(confirm).toBeInTheDocument();
      await confirm.click();
      expect(onRemove).toHaveBeenCalledWith(
        { kind: "store", deploymentId: 77, name: "Memos", templateId: "memos" },
        true,
        false,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("warns plainly before deleting a container the person started", async () => {
    const onRemove = vi.fn();
    const screen = await renderDialog({ tile: tileFor([], [myBot]), onRemove });
    try {
      await page.getByRole("button", { name: "Remove" }).click();
      await expect
        .element(page.getByText(/This was not installed from the App Store/))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Remove", exact: true }).last().click();
      expect(onRemove).toHaveBeenCalledWith(
        { kind: "container", appId: "docker:my-bot", container: "my-bot" },
        false,
        false,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("asks separately about the app's files in the cloud, and says when the folder is shared", async () => {
    const onRemove = vi.fn();
    const screen = await renderDialog({
      tile: tileFor([memos], []),
      onRemove,
      cloudFiles: { appId: "memos", usedBytes: 120 * 1024 * 1024, scope: "account" },
    });
    try {
      await page.getByRole("button", { name: "Remove" }).click();
      const box = page.getByRole("checkbox", { name: /Also delete its files in the cloud/ });
      await expect.element(box).not.toBeChecked();
      await expect.element(page.getByText(/\(120 MB\)/)).toBeInTheDocument();
      await expect
        .element(page.getByText(/this folder is shared\. Memos on your other computers/))
        .toBeInTheDocument();
      await box.click();
      await page.getByRole("button", { name: "Remove and delete files" }).click();
      expect(onRemove).toHaveBeenCalledWith(
        { kind: "store", deploymentId: 77, name: "Memos", templateId: "memos" },
        false,
        true,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("shows progress and can't be sent twice while removing", async () => {
    const screen = await renderDialog({ tile: tileFor([memos], []), pending: true });
    try {
      const button = page.getByRole("button", { name: "Removing…" });
      await expect.element(button).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("changes the AI spending limit and turns it off", async () => {
    const onSave = vi.fn(async () => undefined);
    const screen = await renderDialog({ tile: tileFor([memos], []), onSave });
    try {
      await page.getByRole("button", { name: "Change limit" }).click();
      const input = page.getByLabelText("AI spending limit in dollars");
      await input.fill("25");
      await page.getByRole("button", { name: "Save" }).click();
      expect(onSave).toHaveBeenCalledWith(77, 25);
      await page.getByRole("button", { name: "Change limit" }).click();
      await page.getByRole("button", { name: "No limit" }).click();
      expect(onSave).toHaveBeenLastCalledWith(77, null);
    } finally {
      await screen.unmount();
    }
  });
});
