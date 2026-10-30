import "../../index.css";

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

/**
 * The assistants block of the sidebar, variant D (Misha 28.10): "+" and the
 * gear in its header, no "New assistant" line under the list, the whole block
 * hides behind one "Show assistants" line, an assistant's group of chats
 * folds even while one of them is open, and Uno not set up opens its first
 * run instead of the dialog.
 */

const navigate = vi.fn();
let members: ReadonlyArray<unknown> = [];

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigate,
}));
vi.mock("../assistants/useAssistantTeam", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAssistantTeam: () => members,
  useTeamShown: () => true,
}));
vi.mock("../assistants/useQuickCreateAssistant", () => ({
  useQuickCreateAssistant: () => ({ create: vi.fn(), creating: false, available: true }),
}));
vi.mock("../../hooks/useHandleNewThread", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNewThreadHandler: () => ({ handleNewThread: vi.fn() }),
}));
vi.mock("../../hooks/useMachineRows", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMachineRows: () => [],
  useMachineLabels: () => new Map(),
}));

const { SidebarProvider } = await import("../ui/sidebar");
const { SidebarAssistants, useAssistantsSectionStore } = await import("./SidebarAssistants");

const chat = (id: string, title: string) =>
  ({
    id,
    environmentId: "env-1",
    projectId: "assistant-home",
    title,
    archivedAt: null,
    assistantRole: null,
    spawnedByThreadId: null,
    latestUserMessageAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
    createdAt: "2026-10-28T09:00:00.000Z",
  }) as never;

function member(
  projectId: string,
  name: string,
  options: { configured?: boolean; conversations?: ReadonlyArray<unknown> } = {},
) {
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
      roles: projectId === "assistant-home" ? [] : ["Secretary"],
      createdBy: null,
      createdAt: new Date(0).toISOString(),
      setUpAt: null,
      revokedAt: null,
    },
    summary: null,
    createdBy: null,
    configured: options.configured ?? true,
    revoked: false,
    computerLabel: "uno-work",
    chats: { conversations: options.conversations ?? [], work: [] },
    activity: "idle",
  };
}

function mount(routeThreadKey: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <ul>
          <SidebarAssistants
            routeThreadKey={routeThreadKey}
            unoRunning={[]}
            renderChat={(thread) => (
              <li key={thread.id} data-testid="assistant-chat-row">
                {thread.title}
              </li>
            )}
          />
        </ul>
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  navigate.mockReset();
  localStorage.clear();
  useAssistantsSectionStore.setState({ hidden: false });
  members = [member("assistant-home", "Uno"), member("assistant-mia", "Mia")];
});

describe("the Assistants header", () => {
  it('"+" opens the gallery; no "New assistant" line under the list', async () => {
    const screen = await mount();
    await screen.getByTestId("sidebar-new-assistant").click();
    expect(navigate).toHaveBeenCalledWith({ to: "/assistants", search: { view: "new" } });
    expect(screen.getByTestId("sidebar-new-assistant-row").query()).toBeNull();
  });

  it("the gear opens every assistant and the way into each one's settings", async () => {
    const screen = await mount();
    await userEvent.hover(screen.getByTestId("sidebar-assistants-settings"));
    await expect.element(screen.getByText("All assistants and their settings")).toBeVisible();
    await screen.getByTestId("sidebar-assistants-settings").click();
    expect(navigate).toHaveBeenCalledWith({ to: "/assistants" });
  });

  it("hides the whole block behind one small line, and brings it back", async () => {
    const screen = await mount();
    await screen.getByTestId("sidebar-hide-assistants").click();
    await expect.element(screen.getByTestId("sidebar-show-assistants")).toBeVisible();
    expect(screen.getByTestId("sidebar-assistant").query()).toBeNull();
    expect(screen.getByTestId("sidebar-assistants-header").query()).toBeNull();
    expect(localStorage.getItem("sidebar:assistants-hidden:v1")).toBe("true");
    await screen.getByTestId("sidebar-show-assistants").click();
    await expect.element(screen.getByTestId("sidebar-assistants-header")).toBeVisible();
    expect(screen.getByTestId("sidebar-assistant").elements()).toHaveLength(2);
  });
});

describe("an assistant's row", () => {
  it("has its settings on hover: its gear opens its page", async () => {
    const screen = await mount();
    const mia = screen.getByTestId("sidebar-assistant").nth(1);
    await mia.getByTestId("sidebar-assistant-settings").click();
    expect(navigate).toHaveBeenCalledWith({
      to: "/assistants",
      search: { view: "profile", env: "env-1", project: "assistant-mia" },
    });
  });
});

describe("an assistant's group of chats", () => {
  it("folds while one of its chats is open (the 28.10 bug), and unfolds again", async () => {
    members = [
      member("assistant-home", "Uno", {
        conversations: [chat("c1", "Plan the week"), chat("c2", "Invoices")],
      }),
    ];
    const open = scopedThreadKey(scopeThreadRef("env-1" as EnvironmentId, "c2" as ThreadId));
    const screen = await mount(open);
    await expect.element(screen.getByTestId("sidebar-assistant-chats")).toBeVisible();
    await screen.getByTestId("sidebar-assistant-toggle").click();
    expect(screen.getByTestId("sidebar-assistant-chats").query()).toBeNull();
    // Folded with the open chat inside: the row says "you are here".
    await expect
      .element(screen.getByTestId("sidebar-assistant-open"))
      .toHaveAttribute("aria-current", "page");
    expect(JSON.parse(localStorage.getItem("sidebar:assistants-closed:v1") ?? "[]")).toContain(
      "env-1:assistant-home",
    );
    await screen.getByTestId("sidebar-assistant-toggle").click();
    await expect.element(screen.getByTestId("sidebar-assistant-chats")).toBeVisible();
  });
});

describe("Uno not set up yet", () => {
  it("opens its first run on the assistants page, not the dialog", async () => {
    members = [member("assistant-home", "Uno", { configured: false })];
    const screen = await mount();
    await screen.getByTestId("sidebar-assistant-open").click();
    expect(navigate).toHaveBeenCalledWith({
      href: "/assistants?view=uno-setup&env=env-1",
    });
  });
});
