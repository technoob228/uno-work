import "../../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { SetupConnector, SetupConnectorsState } from "../../../lib/setupApi";

const api = vi.hoisted(() => ({
  listConnectors: vi.fn(),
  startConnector: vi.fn(),
  openAuthWindow: vi.fn(),
  disconnectConnector: vi.fn(),
  probeMcpServer: vi.fn(),
}));

vi.mock("../../../lib/setupApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

import { useConnectorActions } from "./ConnectorsStep";

const gmail = (patch: Partial<SetupConnector>): SetupConnector => ({
  provider: "gmail",
  name: "Gmail & Calendar",
  description: "",
  available: true,
  connected: true,
  account: "misha@example.com",
  connectedAt: "2026-10-01T00:00:00Z",
  toolCount: 12,
  ...patch,
});
const listed = (connector: SetupConnector): SetupConnectorsState => ({
  available: true,
  reason: null,
  connectors: [connector],
});

function Harness() {
  const actions = useConnectorActions(EnvironmentId.make("env-test"));
  return (
    <div>
      <button type="button" onClick={() => void actions.connect("gmail")}>
        Reconnect
      </button>
      <p data-testid="pending">{actions.pending ? actions.pending.action : "none"}</p>
    </div>
  );
}

let queryClient: QueryClient;
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.startConnector.mockResolvedValue({ authorizeUrl: "https://accounts.google.com/o/oauth2" });
  // The consent window stays open while the person signs in.
  api.openAuthWindow.mockReturnValue(new Promise(() => {}));
});
afterEach(() => queryClient.clear());

describe("useConnectorActions — Reconnect of an expired sign-in", () => {
  it("keeps watching until the console lists the new grant", async () => {
    let state = listed(gmail({ needsReconnect: true }));
    api.listConnectors.mockImplementation(async () => state);
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
    await expect.poll(() => api.listConnectors.mock.calls.length).toBeGreaterThan(0);

    await page.getByRole("button", { name: "Reconnect" }).click();
    await expect.element(page.getByTestId("pending")).toHaveTextContent("connect");

    // Two polls with the old, refused grant still listed as "connected": still waiting.
    const before = api.listConnectors.mock.calls.length;
    await expect
      .poll(() => api.listConnectors.mock.calls.length, { timeout: 6_000 })
      .toBeGreaterThanOrEqual(before + 2);
    await expect.element(page.getByTestId("pending")).toHaveTextContent("connect");

    // The person signed in: the next poll ends the wait.
    state = listed(gmail({ needsReconnect: false, connectedAt: "2026-10-28T10:00:00Z" }));
    await expect.element(page.getByTestId("pending"), { timeout: 6_000 }).toHaveTextContent("none");
  });
});
