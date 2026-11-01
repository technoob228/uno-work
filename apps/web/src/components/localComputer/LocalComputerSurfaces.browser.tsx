import "../../index.css";

import type {
  EnvironmentApi,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  MyComputerStatus,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { localComputer, useLocalComputer } from "../../localComputer/localComputerStore";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../assistants/TeammateAccess", () => ({
  useConnectorItems: () => ({ items: [], loading: false }),
}));
vi.mock("../assistants/useAssistantTeam", async (original) => ({
  ...(await original<typeof import("../assistants/useAssistantTeam")>()),
  useAssistantTeam: () => [],
}));
vi.mock("../../lib/setupApi", async (original) => ({
  ...(await original<typeof import("../../lib/setupApi")>()),
  listConnectors: async () => ({ available: true, reason: null, connectors: [] }),
  getAgentMail: async () => ({ mailbox: null }),
  getGithubAccount: async () => ({ connected: false }),
}));
vi.mock("../settings/useSettingsScope", async (original) => ({
  ...(await original<typeof import("../settings/useSettingsScope")>()),
  useSettingsScopeBadge: () => null,
}));

import { ConnectorsSettings } from "../settings/ConnectorsSettings";
import { ConnectorsList } from "../setup/steps/ConnectorsStep";
import { LocalComputerMenuItems } from "./LocalComputerConnector";

const ENVIRONMENT = "env-surfaces" as EnvironmentId;
let status: MyComputerStatus;

function useApi() {
  writePrimaryEnvironmentDescriptor({
    environmentId: ENVIRONMENT,
  } as unknown as ExecutionEnvironmentDescriptor);
  __setEnvironmentApiOverrideForTests(ENVIRONMENT, {
    myComputer: { status: async () => status },
  } as unknown as EnvironmentApi);
}

const show = (node: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>,
  );

beforeEach(() => {
  useApi();
  localComputer.close();
});

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  writePrimaryEnvironmentDescriptor(null);
});

describe("Settings → Connectors", () => {
  it("has a Your computer section for an account with the feature", async () => {
    status = { enabled: true, computers: [] };
    await show(<ConnectorsSettings />);
    await expect.element(page.getByText("Your computer")).toBeVisible();
    await page.getByTestId("connector-connect").click();
    expect(useLocalComputer.getState().dialog).toBe("connect");
  });

  it("has no trace of it otherwise", async () => {
    status = { enabled: false, computers: [] };
    await show(<ConnectorsSettings />);
    await expect.element(page.getByTestId("settings-connectors")).toBeVisible();
    await new Promise((done) => setTimeout(done, 300));
    await expect.element(page.getByText("Your computer")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("connector-my-computer")).not.toBeInTheDocument();
  });
});

describe("the setup's Connectors step", () => {
  it("lists the computer first where it's asked for", async () => {
    status = { enabled: true, computers: [] };
    await show(<ConnectorsList computer />);
    await expect.element(page.getByTestId("connector-my-computer")).toBeVisible();
  });

  it("leaves the shared list alone", async () => {
    status = { enabled: true, computers: [] };
    await show(<ConnectorsList />);
    await expect.element(page.getByTestId("setup-connectors")).toBeVisible();
    await new Promise((done) => setTimeout(done, 300));
    await expect.element(page.getByTestId("connector-my-computer")).not.toBeInTheDocument();
  });
});

describe("the computer menu", () => {
  const laptop = {
    id: "7",
    name: "mikhail-mbp",
    online: true,
    lastSeenAt: "2026-10-30T10:00:00Z",
    helperVersion: "0.1.0",
    os: "darwin",
    arch: "arm64",
  };

  it("closes itself and opens the dialog", async () => {
    status = { enabled: true, computers: [] };
    const closeMenu = vi.fn();
    await show(<LocalComputerMenuItems onOpen={closeMenu} />);
    await page.getByTestId("connect-my-computer").click();
    expect(closeMenu).toHaveBeenCalledOnce();
    expect(useLocalComputer.getState().dialog).toBe("connect");
  });

  it("opens a connected computer the same way", async () => {
    status = { enabled: true, computers: [laptop] } as unknown as MyComputerStatus;
    const closeMenu = vi.fn();
    await show(<LocalComputerMenuItems onOpen={closeMenu} />);
    await page.getByTestId("local-computer-row").click();
    expect(closeMenu).toHaveBeenCalledOnce();
    expect(useLocalComputer.getState()).toMatchObject({ dialog: "manage", manageId: "7" });
  });

  it("has no line for an account without the feature", async () => {
    status = { enabled: false, computers: [] };
    await show(<LocalComputerMenuItems onOpen={vi.fn()} />);
    await new Promise((done) => setTimeout(done, 300));
    await expect.element(page.getByTestId("connect-my-computer")).not.toBeInTheDocument();
  });
});
