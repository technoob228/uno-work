import "../../index.css";

import {
  DEFAULT_SLACK_CONNECTOR_STATUS,
  type ManagerAssistantSummary,
  type ManagerTelegramConnectorStatus,
} from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

/**
 * Misha 23.10: one click on "+" makes an assistant (the "+" is always there
 * with the team), its page leads with Connect Telegram, and everything else
 * — the two modes, projects, apps — is folded under Advanced.
 */

const navigate = vi.fn();
const quickCreate = vi.fn(async () => true);
let teamShown = true;
let members: ReadonlyArray<unknown> = [];

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigate,
}));
vi.mock("./useAssistantTeam", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAssistantTeam: () => members,
  useTeamShown: () => teamShown,
}));
vi.mock("./useQuickCreateAssistant", () => ({
  useQuickCreateAssistant: () => ({ create: quickCreate, creating: false, available: true }),
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => ({ handleNewThread: vi.fn() }),
}));
vi.mock("../../hooks/useMachineRows", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMachineRows: () => [],
  useMachineLabels: () => new Map(),
}));
vi.mock("../../assistant/useAssistantLlm", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAssistantLlm: () => ({ loading: false, status: { provider: "uno" } }),
}));
vi.mock("../assistant/TelegramWizard", () => ({
  TelegramWizard: () => <div data-testid="telegram-wizard">BotFather steps</div>,
}));
vi.mock("../../lib/managerApi", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAssistant: () => Promise.reject(new Error("offline in this test")),
  getAssistantMail: () => Promise.reject(new Error("no mail here")),
  readAssistantFile: () => Promise.resolve({ content: "" }),
  listProjectsForAccessPicker: () => Promise.resolve([{ id: "p-site", title: "site" }]),
  listAssistants: () => Promise.resolve({ assistants: [] }),
}));

const { FULL_ACCESS } = await import("./assistantTeam.logic");
const { SidebarProvider } = await import("../ui/sidebar");
const { AssistantProfileSimple } = await import("./AssistantProfileSimple");
const { SidebarAssistants } = await import("../sidebar/SidebarAssistants");

const telegram = (configured: boolean): ManagerTelegramConnectorStatus =>
  ({
    configured,
    enabled: configured,
    allowedChatIds: configured ? ["1"] : [],
    botUsername: configured ? "scout_bot" : null,
    lastError: null,
    health: null,
    defaultModelSelection: null,
    addressing: DEFAULT_SLACK_CONNECTOR_STATUS.addressing,
    shared: false,
  }) as unknown as ManagerTelegramConnectorStatus;

function member(projectId: string, name: string, options: { telegram?: boolean } = {}) {
  const summary = {
    projectId,
    title: name,
    workspaceRoot: `/home/me/UnoWork/Assistants/${name}`,
    token: {
      scopes: ["threads:read", "threads:write", "threads:approve"],
      projectAllowlist: "all",
    },
    telegram: telegram(options.telegram ?? false),
    slack: DEFAULT_SLACK_CONNECTOR_STATUS,
    skills: [],
    profile: { emoji: "🦊", template: null, createdAt: null, avatar: null },
  } as unknown as ManagerAssistantSummary;
  return {
    key: `env-1:${projectId}`,
    environmentId: "env-1",
    projectId,
    isUno: projectId === "assistant-home",
    profile: {
      environmentId: "env-1",
      projectId,
      name,
      emoji: projectId === "assistant-home" ? null : "🦊",
      avatar: null,
      tone: "orange",
      roles: [],
      character: "",
      skills: [],
      preset: "full",
      brain: "uno",
      channel: "own-bot",
      channelHandle: null,
      projects: "all",
      computers: ["env-1"],
      createdBy: null,
      createdAt: new Date(0).toISOString(),
      setUpAt: new Date(0).toISOString(),
      revokedAt: null,
      access: FULL_ACCESS,
      activity: [],
    },
    summary,
    createdBy: null,
    configured: true,
    revoked: false,
    computerLabel: "My Mac",
    chats: { conversations: [], work: [] },
    activity: "idle",
  };
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>{node}</SidebarProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  teamShown = true;
  navigate.mockReset();
  quickCreate.mockClear();
  members = [member("assistant-home", "Uno"), member("assistant-scout", "Scout")];
});

describe("sidebar: '+' makes an assistant in one click", () => {
  it("is there with several assistants, and one click creates", async () => {
    members = [
      member("assistant-home", "Uno"),
      member("assistant-scout", "Scout"),
      member("assistant-ada", "Ada"),
    ];
    const screen = await wrap(
      <ul>
        <SidebarAssistants routeThreadKey={null} unoRunning={[]} renderChat={() => null} />
      </ul>,
    );
    await expect.element(screen.getByTestId("sidebar-assistants-header")).toBeInTheDocument();
    await screen.getByTestId("sidebar-new-assistant").click();
    expect(quickCreate).toHaveBeenCalledTimes(1);
  });

  it("without the team on the account: Uno alone, no '+'", async () => {
    teamShown = false;
    members = [member("assistant-home", "Uno")];
    const screen = await wrap(
      <ul>
        <SidebarAssistants routeThreadKey={null} unoRunning={[]} renderChat={() => null} />
      </ul>,
    );
    await expect.element(screen.getByText("Uno")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-new-assistant").query()).toBeNull();
  });
});

describe("its page", () => {
  it("leads with Connect Telegram; the rest is under Advanced", async () => {
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await expect.element(screen.getByTestId("assistant-connect-telegram")).toBeInTheDocument();
    expect(screen.getByTestId("telegram-wizard").query()).toBeNull();
    await screen.getByTestId("assistant-connect-telegram-start").click();
    await expect.element(screen.getByTestId("telegram-wizard")).toBeInTheDocument();
    // Advanced is folded until asked.
    expect(screen.getByTestId("assistant-profile-preset").query()).toBeNull();
    await screen.getByTestId("assistant-advanced-toggle").click();
    await expect
      .element(screen.getByTestId("assistant-profile-preset-itself"))
      .toHaveTextContent("Does it itself");
    await expect
      .element(screen.getByTestId("assistant-profile-preset-asks-first"))
      .toHaveTextContent("Asks first");
    // No sandbox here: "Only selected projects" waits for its own computer.
    await expect
      .element(screen.getByTestId("assistant-profile-preset-projects-only"))
      .toBeDisabled();
    await expect
      .element(screen.getByTestId("assistant-profile-preset-projects-note"))
      .toHaveTextContent("Sees everything on this computer");
  });

  it("with Telegram linked: no card, the bot in the rows", async () => {
    members = [
      member("assistant-home", "Uno"),
      member("assistant-scout", "Scout", { telegram: true }),
    ];
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await expect
      .element(screen.getByTestId("assistant-talk-telegram"))
      .toHaveTextContent("@scout_bot");
    expect(screen.getByTestId("assistant-connect-telegram").query()).toBeNull();
  });

  it("its face opens the picker with Upload, Emoji and Persona", async () => {
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await screen.getByTestId("assistant-profile-face").click();
    await expect.element(screen.getByTestId("assistant-face-picker")).toBeInTheDocument();
    await expect.element(screen.getByTestId("assistant-face-upload")).toBeInTheDocument();
    await screen.getByTestId("assistant-face-tab-persona").click();
    await expect.element(screen.getByTestId("assistant-face-persona-robot")).toBeInTheDocument();
    await screen.getByTestId("assistant-face-tab-emoji").click();
    await expect.element(screen.getByTestId("assistant-face-emoji")).toHaveTextContent("People");
  });
});
