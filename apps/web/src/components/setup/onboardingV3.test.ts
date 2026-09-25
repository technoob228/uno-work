import {
  EMPTY_SETUP_PROGRESS,
  markCompleted,
  parseSetupRouteStep,
  setupSidebarState,
} from "./setupModel";
import { describe, expect, it } from "vitest";

import { agentCommand, sshKeyProblem } from "./OwnToolsDialog";
import { mcpProbeProblem } from "./steps/ConnectorsStep";
import { isSharedTelegram, sharedTelegramProblem, telegramConnected } from "./steps/ChannelsStep";
import { materialIcon, readCountLine } from "./steps/MaterialsStep";
import type { ManagerTelegramConnectorStatus } from "@t3tools/contracts";

describe("welcome and tour in the sidebar", () => {
  it("parses the welcome step", () => {
    expect(parseSetupRouteStep("welcome")).toBe("welcome");
  });

  it("shows Set up 0/8 on the welcome screen before a path is picked", () => {
    const state = setupSidebarState(EMPTY_SETUP_PROGRESS, { onWelcome: true });
    expect(state).toMatchObject({ hidden: false, label: "Set up", meta: "0/8", step: "welcome" });
  });

  it("shows Set up · Tour while the tour runs, even on the simple path", () => {
    const simple = { ...EMPTY_SETUP_PROGRESS, mode: "simple" as const };
    expect(setupSidebarState(simple).hidden).toBe(true);
    const touring = setupSidebarState(simple, { tour: "files" });
    expect(touring).toMatchObject({ hidden: false, meta: "Tour" });
    expect(touring.ratio).toBeCloseTo(1 / 3);
    expect(setupSidebarState(simple, { tour: "done" }).ratio).toBe(1);
  });

  it("the finished setup ignores the welcome flag", () => {
    const done = { ...markCompleted({ ...EMPTY_SETUP_PROGRESS, mode: "ai" as const }, "done") };
    expect(setupSidebarState(done, { onWelcome: true }).label).not.toBe("Set up");
  });
});

describe("own tools", () => {
  const key = {
    id: 7,
    name: "Claude Code on misha-work",
    key: "uno_agt_abc",
    mcp_url: "https://console.uno4.dev/api/v1/mcp",
    commands: {} as Record<string, string>,
  };

  it("prefers the console's command, else builds one with the key", () => {
    expect(
      agentCommand("claude-code", { ...key, commands: { "claude-code": "from console" } }),
    ).toBe("from console");
    expect(agentCommand("claude-code", key)).toBe(
      'claude mcp add --transport http uno https://console.uno4.dev/api/v1/mcp --header "Authorization: Bearer uno_agt_abc"',
    );
    expect(agentCommand("codex", key)).toContain(
      'http_headers = { "Authorization" = "Bearer uno_agt_abc" }',
    );
    expect(JSON.parse(agentCommand("cursor", key))).toEqual({
      mcpServers: {
        uno: {
          url: "https://console.uno4.dev/api/v1/mcp",
          headers: { Authorization: "Bearer uno_agt_abc" },
        },
      },
    });
  });

  it("checks a public SSH key before sending it", () => {
    expect(sshKeyProblem("")).toMatch(/Paste your public key/);
    expect(sshKeyProblem("-----BEGIN OPENSSH PRIVATE KEY-----")).toMatch(/private key/);
    expect(sshKeyProblem("hello")).toMatch(/doesn't look like/);
    expect(sshKeyProblem("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB you@laptop")).toBeNull();
    expect(sshKeyProblem("ssh-rsa AAAAB3NzaC1yc2E=")).toBeNull();
  });
});

describe("connectors and channels", () => {
  it("explains a failed MCP check in plain words", () => {
    const base = { ok: false, toolCount: 0, toolNames: [], needsAuth: false, error: null };
    expect(mcpProbeProblem({ ...base, needsAuth: true })).toMatch(/sign-in/);
    expect(mcpProbeProblem({ ...base, error: "timeout" })).toMatch(/timeout/);
  });

  it("tells the shared bot from an own bot and a linked chat from none", () => {
    const telegram = {
      configured: true,
      enabled: true,
      allowedChatIds: [] as string[],
      botUsername: "get_uno_bot",
      lastError: null,
      health: null,
      defaultModelSelection: null,
      addressing: { names: [], requireMentionInGroups: true, smartWake: false, hotWindowSec: 0 },
    } as unknown as ManagerTelegramConnectorStatus;
    expect(isSharedTelegram(telegram)).toBe(false);
    expect(isSharedTelegram({ ...telegram, shared: true } as ManagerTelegramConnectorStatus)).toBe(
      true,
    );
    expect(telegramConnected(telegram)).toBe(false);
  });

  it("says why Uno's bot can't be used", () => {
    expect(sharedTelegramProblem(new Error("409: not_cloud_computer"))).toMatch(/cloud computers/);
    expect(sharedTelegramProblem(new Error("503"))).toMatch(/isn’t available/);
  });
});

describe("material", () => {
  it("counts what was read", () => {
    expect(readCountLine(5, 1)).toBe("5 files and 1 link");
    expect(readCountLine(1, 0)).toBe("1 file");
    expect(readCountLine(0, 2)).toBe("2 links");
  });

  it("picks an icon by type", () => {
    expect(materialIcon({ name: "price-list.xlsx", kind: "file" }).displayName ?? "x").toBeTruthy();
    expect(materialIcon({ name: "a", kind: "link" })).not.toBe(
      materialIcon({ name: "a.pdf", kind: "file" }),
    );
    expect(materialIcon({ name: "p.png", kind: "file" })).not.toBe(
      materialIcon({ name: "a.pdf", kind: "file" }),
    );
  });
});
