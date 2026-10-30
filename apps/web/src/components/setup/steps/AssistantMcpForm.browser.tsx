import "../../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  listConnectors: vi.fn(),
  probeMcpServer: vi.fn(),
  listAssistantMcp: vi.fn(),
  addAssistantMcp: vi.fn(),
  removeAssistantMcp: vi.fn(),
}));

vi.mock("../../../lib/setupApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...api,
}));

import { AssistantMcpForm } from "./ConnectorsStep";

const ENV = EnvironmentId.make("env-ada-computer");

let queryClient: QueryClient;
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => queryClient.clear());

const mount = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <AssistantMcpForm environmentId={ENV} projectId="assistant-ada" name="Ada" />
    </QueryClientProvider>,
  );

describe("AssistantMcpForm — a server for one assistant", () => {
  it("lists the host only, adds through the assistant's computer after a check", async () => {
    api.listAssistantMcp.mockResolvedValue({
      servers: [{ name: "crm", host: "crm.example.com", enabled: true }],
    });
    api.probeMcpServer.mockResolvedValue({
      ok: true,
      toolCount: 3,
      toolNames: [],
      needsAuth: false,
      error: null,
    });
    api.addAssistantMcp.mockResolvedValue({
      name: "linear",
      servers: [
        { name: "crm", host: "crm.example.com", enabled: true },
        { name: "linear", host: "mcp.linear.app", enabled: true },
      ],
    });
    mount();
    await expect.element(page.getByText("crm.example.com")).toBeVisible();
    await expect
      .element(page.getByText("Only Ada’s chats get its tools", { exact: false }))
      .toBeVisible();

    await page.getByTestId("assistant-mcp-url").fill("https://mcp.linear.app/sse");
    await page.getByTestId("assistant-mcp-add").click();
    await expect.element(page.getByText("mcp.linear.app")).toBeVisible();
    expect(api.probeMcpServer).toHaveBeenCalledWith({
      environmentId: ENV,
      url: "https://mcp.linear.app/sse",
    });
    expect(api.addAssistantMcp).toHaveBeenCalledWith({
      environmentId: ENV,
      projectId: "assistant-ada",
      url: "https://mcp.linear.app/sse",
    });
  });

  it("shows the daemon's sentence when it refuses, and an older Uno Work honestly", async () => {
    api.listAssistantMcp.mockResolvedValue({ servers: [] });
    api.probeMcpServer.mockResolvedValue({
      ok: true,
      toolCount: 1,
      toolNames: [],
      needsAuth: false,
      error: null,
    });
    api.addAssistantMcp.mockRejectedValue(
      new Error("This server is already added for this assistant."),
    );
    mount();
    await page.getByTestId("assistant-mcp-url").fill("https://mcp.linear.app/sse");
    await page.getByTestId("assistant-mcp-add").click();
    await expect
      .element(page.getByText("This server is already added for this assistant."))
      .toBeVisible();

    queryClient.clear();
    api.listAssistantMcp.mockRejectedValue(new Error("404"));
    mount();
    await expect
      .element(page.getByText("can’t keep servers for one assistant yet", { exact: false }))
      .toBeVisible();
  });
});
