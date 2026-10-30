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
 * Misha 23.10 / assistants D 28.10: the "+" is always there with the team and
 * opens the gallery of characters; its page shows where you talk as rows —
 * Telegram (its own bot) and Slack linked right there — and everything else
 * — the two modes, projects, apps — is folded under Advanced.
 */

const navigate = vi.fn();
const quickCreate = vi.fn(async () => true);
let teamShown = true;
let members: ReadonlyArray<unknown> = [];

const historyBack = vi.fn();
let canGoBack = false;
let tabInUrl: string | undefined;
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigate,
  useSearch: () => ({ tab: tabInUrl }),
  useCanGoBack: () => canGoBack,
  useRouter: () => ({ history: { back: historyBack } }),
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
  canGoBack = false;
  tabInUrl = undefined;
  historyBack.mockReset();
  navigate.mockReset();
  quickCreate.mockClear();
  members = [member("assistant-home", "Uno"), member("assistant-scout", "Scout")];
});

describe("sidebar: '+' opens the gallery", () => {
  it("is there with several assistants, and one click opens the gallery", async () => {
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
    expect(navigate).toHaveBeenCalledWith({ to: "/assistants", search: { view: "new" } });
    expect(quickCreate).not.toHaveBeenCalled();
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
  it("links its own Telegram bot on Apps & Telegram", async () => {
    tabInUrl = "apps";
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await expect
      .element(screen.getByTestId("assistant-talk-telegram"))
      .toHaveTextContent("its own bot");
    // Audit 27.10 #14: "Link" opens the channel here, not the older page.
    await screen.getByTestId("assistant-talk-telegram-link").click();
    await expect.element(screen.getByTestId("uno-connect-telegram-dialog")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Close" }).first().click();
  });

  it("its projects are picked on Where it works, without a second level switch", async () => {
    tabInUrl = "where";
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    // "Where it can look": the projects, no second permission switch (Misha 29.10).
    await expect
      .element(screen.getByTestId("assistant-profile-where"))
      .toHaveTextContent("All projects");
    expect(screen.getByTestId("assistant-profile-preset-itself").query()).toBeNull();
    expect(screen.getByTestId("assistant-profile-preset-asks-first").query()).toBeNull();
    // No sandbox here: "Only selected projects" waits for its own computer.
    await expect
      .element(screen.getByTestId("assistant-profile-preset-projects-only"))
      .toBeDisabled();
    await expect
      .element(screen.getByTestId("assistant-profile-preset-projects-note"))
      .toHaveTextContent("Sees everything on this computer");
  });

  it("the permission level is changed in one place: General", async () => {
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await expect
      .element(screen.getByTestId("assistant-profile-tab-general"))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(screen.getByTestId("assistant-mode-switch")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-profile-access").query()).toBeNull();
    expect(screen.getByTestId("assistant-advanced-toggle").query()).toBeNull();
  });

  it("a tab click stays on its page and replaces the entry (Back goes to the chat)", async () => {
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await screen.getByTestId("assistant-profile-tab-memory").click();
    expect(navigate).toHaveBeenCalledWith({
      to: "/assistants",
      search: { view: "profile", env: "env-1", project: "assistant-scout", tab: "memory" },
      replace: true,
    });
  });

  it("with Telegram linked: no card, the bot in the rows", async () => {
    tabInUrl = "apps";
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

  it("Where it works: its computer, projects and AI", async () => {
    tabInUrl = "where";
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await expect
      .element(screen.getByTestId("assistant-profile-works-on-section"))
      .toBeInTheDocument();
    await expect.element(screen.getByTestId("assistant-profile-where")).toBeInTheDocument();
    await expect.element(screen.getByText("The AI it runs on")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-mode-switch").query()).toBeNull();
  });

  it("Memory & instructions: edited on its own tab, not on another page", async () => {
    tabInUrl = "memory";
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await expect.element(screen.getByTestId("assistant-profile-memory-editor")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("Back returns where the person came from", async () => {
    canGoBack = true;
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await expect.element(screen.getByTestId("assistant-profile-back")).toHaveTextContent("Back");
    await screen.getByTestId("assistant-profile-back").click();
    expect(historyBack).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opened by a link, Back goes to all assistants", async () => {
    const screen = await wrap(
      <AssistantProfileSimple environmentId="env-1" projectId="assistant-scout" />,
    );
    await expect
      .element(screen.getByTestId("assistant-profile-back"))
      .toHaveTextContent("All assistants");
    await screen.getByTestId("assistant-profile-back").click();
    expect(navigate).toHaveBeenCalledWith({ to: "/assistants" });
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
