import "../../index.css";

import type {
  EnvironmentApi,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  MyComputer,
  MyComputerActivity,
  MyComputerPairing,
  MyComputerPairStatus,
  MyComputerStatus,
} from "@t3tools/contracts";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { localComputer, useLocalComputer } from "../../localComputer/localComputerStore";
import { ConnectComputerDialog } from "./ConnectComputerDialog";
import { LocalComputerConnector, LocalComputerMenuItems } from "./LocalComputerConnector";

const ENVIRONMENT = "env-connect" as EnvironmentId;

const pairingOf = (code: string): MyComputerPairing => ({
  code,
  url: `https://app.uno4.work/c/${code}`,
  commands: {
    mac: `curl -fsSL https://app.uno4.work/c/${code} | sh`,
    linux: `(curl -fsSL https://app.uno4.work/c/${code} || wget -qO- https://app.uno4.work/c/${code}) | sh`,
    windows: `irm "https://app.uno4.work/c/${code}?ps=1" | iex`,
  },
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
});

const laptop = (patch: Partial<MyComputer> = {}): MyComputer => ({
  id: "7",
  name: "mikhail-mbp",
  os: "darwin",
  arch: "arm64",
  online: true,
  connectedAt: "2026-10-31T10:00:00Z",
  lastSeenAt: "2026-10-31T10:00:00Z",
  helperVersion: "0.1.0",
  ...patch,
});

const waiting: MyComputerPairStatus = {
  state: "waiting",
  step: null,
  message: null,
  computerId: null,
};

let status: MyComputerStatus;
let pairStatus: MyComputerPairStatus;
let activity: MyComputerActivity;

const api = {
  status: vi.fn(async () => status),
  pair: vi.fn(async () => pairingOf(`CODE-000${api.pair.mock.calls.length}`)),
  pairStatus: vi.fn(async (_: { code: string }) => pairStatus),
  disconnect: vi.fn(async (_: { computerId: string }) => {
    status = { ...status, computers: [] };
  }),
  activity: vi.fn(async (_: { computerId: string }) => activity),
};

let queryClient: QueryClient;

function show() {
  return render(
    <QueryClientProvider client={queryClient}>
      <div data-testid="rows">
        <LocalComputerConnector />
      </div>
      <div data-testid="menu">
        <LocalComputerMenuItems onOpen={() => {}} />
      </div>
      <ConnectComputerDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  status = { enabled: true, computers: [] };
  pairStatus = waiting;
  activity = [];
  for (const fn of Object.values(api)) fn.mockClear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  writePrimaryEnvironmentDescriptor({
    environmentId: ENVIRONMENT,
  } as unknown as ExecutionEnvironmentDescriptor);
  __setEnvironmentApiOverrideForTests(ENVIRONMENT, {
    myComputer: api,
  } as unknown as EnvironmentApi);
  localComputer.close();
});

afterEach(() => {
  queryClient.clear();
  __resetEnvironmentApiOverridesForTests();
  writePrimaryEnvironmentDescriptor(null);
});

async function openCommand() {
  await page.getByTestId("connector-connect").click();
  await expect.element(page.getByTestId("connect-warning")).toBeVisible();
  await page.getByTestId("connect-accept").click();
  await expect.element(page.getByTestId("connect-command")).toBeVisible();
}

describe("the account without the feature", () => {
  it("shows no trace of it", async () => {
    status = { enabled: false, computers: [] };
    await show();
    await expect.poll(() => api.status.mock.calls.length).toBeGreaterThan(0);
    await expect.element(page.getByTestId("rows")).toBeEmptyDOMElement();
    await expect.element(page.getByTestId("menu")).toBeEmptyDOMElement();
  });

  it("shows no trace of it on a daemon without the method either", async () => {
    __setEnvironmentApiOverrideForTests(ENVIRONMENT, {
      myComputer: {},
    } as unknown as EnvironmentApi);
    await show();
    await expect.element(page.getByTestId("rows")).toBeEmptyDOMElement();
    await expect.element(page.getByTestId("menu")).toBeEmptyDOMElement();
  });
});

describe("connecting", () => {
  it("warns first and asks for no code until the person agrees", async () => {
    await show();
    await page.getByTestId("connector-connect").click();
    const warning = page.getByTestId("connect-warning");
    await expect.element(warning).toHaveTextContent("Agent gets full access to this computer");
    await expect.element(warning).toHaveTextContent("anything you can’t afford to lose");
    expect(api.pair).not.toHaveBeenCalled();
  });

  it("shows the command of each system and how to open its terminal", async () => {
    await show();
    await openCommand();
    useLocalComputer.setState({ os: "mac" });
    await expect.element(page.getByTestId("connect-copy")).toHaveTextContent("curl -fsSL");
    await expect.element(page.getByTestId("connect-mac-note")).toBeVisible();

    await page.getByTestId("connect-os-windows").click();
    await expect.element(page.getByRole("heading")).toHaveTextContent("Paste this into PowerShell");
    await expect.element(page.getByTestId("connect-copy")).toHaveTextContent("irm");
    await page.getByTestId("connect-howto").click();
    await expect
      .element(page.getByTestId("connect-howto-text"))
      .toHaveTextContent("Windows 10 or 11");

    await page.getByTestId("connect-os-linux").click();
    await expect.element(page.getByTestId("connect-copy")).toHaveTextContent("wget");
    await expect.element(page.getByTestId("connect-howto-text")).not.toBeInTheDocument();
  });

  it("calls it connected only when the computer is online", async () => {
    await show();
    await openCommand();
    pairStatus = { ...waiting, state: "claimed", computerId: "7" };
    status = { enabled: true, computers: [laptop({ online: false })] };
    await expect
      .element(page.getByTestId("connect-command"), { timeout: 6_000 })
      .toHaveTextContent("Finishing setup…");

    status = { enabled: true, computers: [laptop()] };
    await expect
      .element(page.getByTestId("connect-done"), { timeout: 6_000 })
      .toHaveTextContent("mikhail-mbp is connected");
    await page.getByTestId("connect-finish").click();
    await expect.element(page.getByTestId("connector-computer-7")).toHaveTextContent("Connected");
  });

  it("stops polling the pairing once the dialog closes", async () => {
    await show();
    await openCommand();
    await expect.poll(() => api.pairStatus.mock.calls.length).toBeGreaterThan(0);
    await page.getByTestId("connect-x").click();
    await expect.element(page.getByTestId("connect-command")).not.toBeInTheDocument();
    const calls = api.pairStatus.mock.calls.length;
    await new Promise((done) => setTimeout(done, 2_500));
    expect(api.pairStatus.mock.calls.length).toBe(calls);
  });

  it("asks nothing while the tab is hidden and asks at once on return", async () => {
    await show();
    await openCommand();
    await expect.poll(() => api.pairStatus.mock.calls.length).toBeGreaterThan(0);
    focusManager.setFocused(false);
    try {
      const calls = api.pairStatus.mock.calls.length;
      await new Promise((done) => setTimeout(done, 2_500));
      expect(api.pairStatus.mock.calls.length).toBe(calls);
      focusManager.setFocused(true);
      await expect.poll(() => api.pairStatus.mock.calls.length).toBeGreaterThan(calls);
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  it("gets a new code in one action when this one expires", async () => {
    await show();
    await openCommand();
    pairStatus = { ...waiting, state: "expired" };
    await expect
      .element(page.getByTestId("connect-expired"), { timeout: 6_000 })
      .toHaveTextContent("This code expired");
    pairStatus = waiting;
    await page.getByTestId("connect-new-code").click();
    await expect.element(page.getByTestId("connect-command")).toBeVisible();
    expect(api.pair).toHaveBeenCalledTimes(2);
    await expect.element(page.getByTestId("connect-copy")).toHaveTextContent("CODE-0002");
  });

  it("says why a code couldn't be issued and lets the person try again", async () => {
    api.pair.mockRejectedValueOnce(new Error("Too many codes. Try again in a minute."));
    await show();
    await page.getByTestId("connector-connect").click();
    await page.getByTestId("connect-accept").click();
    await expect
      .element(page.getByTestId("connect-pair-error"))
      .toHaveTextContent("Too many codes. Try again in a minute.");
    await page.getByTestId("connect-accept").click();
    await expect.element(page.getByTestId("connect-command")).toBeVisible();
  });
});

describe("a failed install", () => {
  it("shows the step and the next command, and turns by itself when it works", async () => {
    await show();
    await openCommand();
    pairStatus = {
      ...waiting,
      state: "failed",
      step: "download",
      message: "Could not download the helper. Check your internet connection and try again.",
    };
    const fix = page.getByTestId("connect-fix");
    await expect
      .element(fix, { timeout: 6_000 })
      .toHaveTextContent("This computer can’t reach Uno");
    await expect
      .element(page.getByTestId("connect-failed-step"))
      .toHaveTextContent("Stopped at: Downloading the helper");
    await expect.element(fix.getByTestId("connect-copy")).toBeVisible();

    pairStatus = { ...waiting, state: "claimed", computerId: "7" };
    status = { enabled: true, computers: [laptop()] };
    await expect.element(page.getByTestId("connect-done"), { timeout: 6_000 }).toBeVisible();
  });

  it("offers a new code when the failure used the code up", async () => {
    await show();
    await openCommand();
    pairStatus = {
      ...waiting,
      state: "failed",
      step: "claim",
      message: "This command has expired or was already used. Get a new one in Uno Work.",
    };
    await expect
      .element(page.getByTestId("connect-fix"), { timeout: 6_000 })
      .toHaveTextContent("This command no longer works");
    await expect.element(page.getByTestId("connect-copy")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("connect-new-code")).toBeVisible();
  });

  it("keeps what the computer sent as text", async () => {
    await show();
    await openCommand();
    const message = '<img src=x onerror="window.__owned=1"><b>boom</b>';
    pairStatus = { ...waiting, state: "failed", step: "install", message };
    const shown = page.getByTestId("connect-failed-message");
    await expect.element(shown, { timeout: 6_000 }).toHaveTextContent(message);
    expect(shown.element().querySelector("img, b")).toBeNull();
    expect((window as { __owned?: number }).__owned).toBeUndefined();
  });

  it("gives the next step for what the person pasted", async () => {
    await show();
    await openCommand();
    await page.getByTestId("connect-os-windows").click();
    await page.getByTestId("connect-copy").getByRole("button").click();
    await page.getByTestId("connect-stuck").click();
    await page
      .getByTestId("connect-stuck-text")
      .fill("'irm' is not recognized as an internal or external command,");
    await page.getByTestId("connect-stuck-send").click();
    const fix = page.getByTestId("connect-fix");
    await expect.element(fix).toHaveTextContent("You opened Command Prompt");
    await expect.element(fix.getByTestId("connect-copy")).toHaveTextContent("powershell -c");
    await fix.getByRole("button", { name: "Back" }).click();
    await expect.element(page.getByTestId("connect-command")).toBeVisible();
  });
});

describe("a connected computer", () => {
  it("shows when an offline one was last seen and what the agents did", async () => {
    status = {
      enabled: true,
      computers: [
        laptop({ online: false, lastSeenAt: new Date(Date.now() - 7_200_000).toISOString() }),
      ],
    };
    activity = [
      { at: new Date().toISOString(), kind: "run", summary: "ls -t ~/Downloads" },
      { at: "2026-10-01T10:00:00Z", kind: "read", summary: "<b>~/notes.txt</b>" },
    ];
    await show();
    await expect
      .element(page.getByTestId("connector-computer-7"))
      .toHaveTextContent("Offline · last seen 2h ago");
    await page.getByRole("button", { name: "Manage computer" }).click();
    await expect
      .element(page.getByTestId("connect-manage-status"))
      .toHaveTextContent("Offline · last seen 2h ago");
    const journal = page.getByTestId("connect-actions");
    await expect.element(journal).toHaveTextContent("Ran ls -t ~/Downloads");
    await expect.element(journal).toHaveTextContent("Read <b>~/notes.txt</b>");
    expect(api.activity.mock.calls[0]?.[0]).toMatchObject({ computerId: "7" });
  });

  it("disconnects only after the confirmation", async () => {
    status = { enabled: true, computers: [laptop()] };
    await show();
    await page.getByRole("button", { name: "Manage computer" }).click();
    await page.getByTestId("connect-disconnect").click();
    await expect
      .element(page.getByTestId("connect-disconnect-confirm"))
      .toHaveTextContent("Disconnect mikhail-mbp?");
    expect(api.disconnect).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.element(page.getByTestId("connect-manage")).toBeVisible();
    expect(api.disconnect).not.toHaveBeenCalled();

    await page.getByTestId("connect-disconnect").click();
    await page.getByTestId("connect-disconnect-confirm-button").click();
    await expect.element(page.getByTestId("connector-connect")).toBeVisible();
    expect(api.disconnect).toHaveBeenCalledWith({ computerId: "7" });
    expect(useLocalComputer.getState().dialog).toBeNull();
  });

  it("keeps the card and says so when disconnecting fails", async () => {
    status = { enabled: true, computers: [laptop()] };
    api.disconnect.mockRejectedValueOnce(new Error("The console is down."));
    await show();
    await page.getByRole("button", { name: "Manage computer" }).click();
    await page.getByTestId("connect-disconnect").click();
    await page.getByTestId("connect-disconnect-confirm-button").click();
    await expect
      .element(page.getByTestId("connect-disconnect-confirm"))
      .toHaveTextContent("The console is down.");
  });
});
