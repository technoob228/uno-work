import type { ProviderInstallJobStatus, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveAssistantHarnessStatus, orderAssistantModels } from "./assistantLlm.ts";

const snapshot = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "hermes",
    driver: "hermes",
    displayName: "Hermes",
    enabled: false,
    installed: true,
    version: "0.18.0",
    status: "disabled",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-24T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

const job = (overrides: Partial<ProviderInstallJobStatus>): ProviderInstallJobStatus =>
  ({
    jobId: "job-1",
    driver: "hermes",
    state: "running",
    log: "",
    command: "uv tool install",
    ...overrides,
  }) as ProviderInstallJobStatus;

describe("deriveAssistantHarnessStatus", () => {
  it("is ready when the probe found hermes — even with Hermes hidden from pickers", () => {
    expect(deriveAssistantHarnessStatus({ snapshot: snapshot({}), job: null })).toMatchObject({
      state: "ready",
      version: "0.18.0",
    });
  });

  it("is checking until the first probe lands", () => {
    expect(
      deriveAssistantHarnessStatus({
        snapshot: snapshot({ version: null, message: "Checking Hermes Agent availability..." }),
        job: null,
      }).state,
    ).toBe("checking");
    expect(deriveAssistantHarnessStatus({ snapshot: undefined, job: null }).state).toBe("checking");
  });

  it("is missing when not installed and nothing runs", () => {
    expect(
      deriveAssistantHarnessStatus({
        snapshot: snapshot({ installed: false, version: null }),
        job: null,
      }).state,
    ).toBe("missing");
  });

  it("shows progress of a running install", () => {
    const status = deriveAssistantHarnessStatus({
      snapshot: snapshot({ installed: false, version: null }),
      job: job({ log: "$ uv tool install\nResolved 90 packages\nInstalled 90 packages\n" }),
    });
    expect(status.state).toBe("installing");
    expect(status.logTail).toContain("Installed 90 packages");
  });

  it("waits for the probe right after a successful install", () => {
    expect(
      deriveAssistantHarnessStatus({
        snapshot: snapshot({ installed: false, version: null }),
        job: job({ state: "succeeded" }),
      }).state,
    ).toBe("checking");
  });

  it("explains a failed install", () => {
    const status = deriveAssistantHarnessStatus({
      snapshot: snapshot({ installed: false, version: null }),
      job: job({ state: "failed", error: "Installer exited with code 127. sh: curl: not found" }),
    });
    expect(status).toMatchObject({ state: "failed" });
    expect(status.message).toContain("curl");
  });

  it("says it is the network when the download failed", () => {
    const status = deriveAssistantHarnessStatus({
      snapshot: snapshot({ installed: false, version: null }),
      job: job({
        state: "failed",
        error: "Installer exited with code 7.",
        log: "curl: (7) Failed to connect to astral.sh port 443\n",
      }),
    });
    expect(status.message).toContain("internet connection");
    expect(status.logTail).toContain("curl: (7)");
  });

  it("marks a platform without an installer as unsupported", () => {
    expect(
      deriveAssistantHarnessStatus({
        snapshot: snapshot({ installed: false, version: null }),
        job: job({
          state: "failed",
          error: "Hermes is installed with uv, which is not available on this machine.",
        }),
      }).state,
    ).toBe("unsupported");
  });

  it("flags a Hermes whose MCP SDK cannot do HTTP (mcp 2.x)", () => {
    const status = deriveAssistantHarnessStatus({
      snapshot: snapshot({}),
      job: null,
      mcp: "broken",
    });
    expect(status.state).toBe("failed");
    expect(status.message).toContain("MCP library");
    expect(
      deriveAssistantHarnessStatus({ snapshot: snapshot({}), job: null, mcp: "unknown" }).state,
    ).toBe("ready");
  });

  it("reports an installed hermes that does not start", () => {
    expect(
      deriveAssistantHarnessStatus({
        snapshot: snapshot({ version: null, status: "error", message: "timed out" }),
        job: null,
      }),
    ).toMatchObject({ state: "failed", message: "timed out" });
  });
});

describe("orderAssistantModels", () => {
  it("puts the latest-Grok alias first, then Grok releases newest first, then the rest", () => {
    const ordered = orderAssistantModels(
      [
        { id: "openai/gpt-5", name: "GPT-5" },
        { id: "x-ai/grok-4.20", name: "Grok 4.20" },
        { id: "x-ai/grok-4.7", name: "Grok 4.7" },
        { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku" },
      ],
      { ensureGatewayAlias: true },
    ).map((model) => model.id);
    expect(ordered).toEqual([
      "~x-ai/grok-latest",
      "x-ai/grok-4.7",
      "x-ai/grok-4.20",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5",
    ]);
  });
});
