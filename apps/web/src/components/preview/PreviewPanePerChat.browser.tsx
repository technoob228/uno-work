import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

/**
 * Labs flags as the test wants them: the real value unless a test forces one
 * (the stage's w0139 flags are off by default, as in a release build).
 */
const forcedFlags = vi.hoisted(() => ({ value: {} as Record<string, boolean> }));
vi.mock("../../hooks/useFeatureFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useFeatureFlags")>();
  return {
    ...actual,
    useFeatureFlag: (key: Parameters<typeof actual.useFeatureFlag>[0]) => {
      const real = actual.useFeatureFlag(key);
      return key in forcedFlags.value ? forcedFlags.value[key]! : real;
    },
  };
});

import { SidebarProvider } from "../ui/sidebar";
import { PreviewPane } from "./PreviewPane";
import {
  PreviewPaneProvider,
  useChatPanelContext,
  usePreviewPane,
  type PreviewFile,
} from "./PreviewPaneContext";

/**
 * Панель «живёт в чате»: настоящие PreviewPaneProvider + PreviewPane, а
 * маршруты изображает переключатель экранов. Чат регистрирует себя тем же
 * хуком, что и ChatView, — уход с чата снимает его панель с экрана.
 */

type Screen = "chat-a" | "chat-b" | "home";

function threadOf(screen: Screen): string | null {
  return screen === "home" ? null : `thread-${screen.slice("chat-".length)}`;
}

function Chat({ threadId }: { threadId: string }) {
  useChatPanelContext({
    projectKey: "proj",
    projectCwd: "/home/me/proj",
    projectId: null,
    environmentId: null,
    threadId,
  });
  return <div data-testid="chat">{threadId}</div>;
}

function report(id: string): PreviewFile {
  return { id, name: `${id}.md`, kind: "md", content: `# ${id}` };
}

/** Шапка чата и «агент»: то, что в приложении делают ChatHeader и BrowserBridgeListener. */
function Controls({ screen, setScreen }: { screen: Screen; setScreen: (s: Screen) => void }) {
  const { open, files, unseenCount, toggleOpen, openFileForTarget } = usePreviewPane();
  const threadId = threadOf(screen);
  return (
    <div>
      <button type="button" onClick={() => setScreen("chat-a")}>
        go chat A
      </button>
      <button type="button" onClick={() => setScreen("chat-b")}>
        go chat B
      </button>
      <button type="button" onClick={() => setScreen("home")}>
        go home
      </button>
      <button
        type="button"
        onClick={() =>
          openFileForTarget(
            { projectKey: "proj", threadId: "thread-a" },
            "chat",
            report(`agent-${Date.now()}`),
            "agent",
          )
        }
      >
        agent opens in chat A
      </button>
      {threadId && files.length > 0 ? (
        <button type="button" onClick={toggleOpen} data-testid="toggle">
          panel {open ? "open" : "closed"}
          {!open && unseenCount > 0 ? <span data-testid="badge">{unseenCount} new</span> : null}
        </button>
      ) : null}
    </div>
  );
}

/** PreviewPane reads the route (useOpenApp → useMatch): a router around the harness. */
function App() {
  const [router] = useState(() =>
    createRouter({
      routeTree: createRootRoute({ component: Harness }),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    }),
  );
  return <RouterProvider router={router} />;
}

function Harness() {
  const [screen, setScreen] = useState<Screen>("chat-a");
  const threadId = threadOf(screen);
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <PreviewPaneProvider>
        <SidebarProvider defaultOpen={false}>
          <main className="flex-1">
            {threadId ? <Chat key={threadId} threadId={threadId} /> : <div>home screen</div>}
            <Controls screen={screen} setScreen={setScreen} />
          </main>
          <PreviewPane />
        </SidebarProvider>
      </PreviewPaneProvider>
    </QueryClientProvider>
  );
}

function paneVisible(): boolean {
  const aside = document.querySelector("aside");
  return aside !== null && aside.getAttribute("aria-hidden") === "false";
}

describe("right panel lives in the chat", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("follows the chat, not the person: chat → Home → chat B → back", async () => {
    const screen = await render(<App />);
    await screen.getByRole("button", { name: "agent opens in chat A" }).click();
    await expect.poll(paneVisible).toBe(true);

    await screen.getByRole("button", { name: "go home" }).click();
    await expect.poll(paneVisible).toBe(false);

    await screen.getByRole("button", { name: "go chat B" }).click();
    await expect.poll(paneVisible).toBe(false);

    await screen.getByRole("button", { name: "go chat A" }).click();
    await expect.poll(paneVisible).toBe(true);
  });

  it("a panel the person closed is not reopened by the agent — a badge shows instead", async () => {
    const screen = await render(<App />);
    await screen.getByRole("button", { name: "agent opens in chat A" }).click();
    await expect.poll(paneVisible).toBe(true);

    await screen.getByTestId("toggle").click();
    await expect.poll(paneVisible).toBe(false);

    await screen.getByRole("button", { name: "agent opens in chat A" }).click();
    await expect.element(screen.getByTestId("badge")).toHaveTextContent("1 new");
    expect(paneVisible()).toBe(false);

    await screen.getByTestId("toggle").click();
    await expect.poll(paneVisible).toBe(true);
    await expect.element(page.getByTestId("badge")).not.toBeInTheDocument();
  });

  it("old saved panel state does not open the panel on Home after the update", async () => {
    // Сохранёнка 0.0.104: закреплённая браузерная вкладка, флага v2 нет.
    window.localStorage.setItem(
      "uno_preview_tabs_v1",
      JSON.stringify({ global: [{ id: "browser-7", name: "Docs", url: "https://example.com/" }] }),
    );
    const screen = await render(<App />);
    await screen.getByRole("button", { name: "go home" }).click();
    expect(paneVisible()).toBe(false);
  });
});

describe("Labs flags of the stage (w0139) — off is 0.0.137", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    forcedFlags.value = {};
  });

  async function openLauncherOverATab() {
    const screen = await render(<App />);
    await screen.getByRole("button", { name: "agent opens in chat A" }).click();
    await expect.poll(paneVisible).toBe(true);
    await screen.getByTestId("panel-launcher-open").click();
    return screen;
  }

  it("flags off: the tab row, header and launcher of 0.0.137", async () => {
    const screen = await openLauncherOverATab();
    // The plain tab row (right-click menu), no pins, no "All tabs".
    await expect.poll(() => document.querySelectorAll("[data-preview-tab]").length).toBe(1);
    expect(document.querySelector('[data-testid="panel-pinned-tabs"]')).toBeNull();
    expect(document.querySelector('[data-testid="panel-all-tabs"]')).toBeNull();
    // "Focus preview" as before, not the new full-screen pair.
    await expect.element(screen.getByRole("button", { name: "Focus preview" })).toBeVisible();
    // The 0.0.137 launcher: no Apps tile when no app opens, no agent's browser.
    await expect.element(screen.getByText("Open in the panel")).toBeVisible();
    expect(document.querySelector('[data-testid="panel-launcher-apps"]')).toBeNull();
    expect(document.querySelector('[data-testid="panel-launcher-list"]')).toBeNull();
    // The agent's tab carries no mark.
    expect(document.querySelector('[aria-label="Opened by the agent"]')).toBeNull();
  });

  it("flags on: pins + All tabs, the agent's mark, Apps always in the launcher", async () => {
    forcedFlags.value = { panelLauncherV2: true, panelTabPins: true, fullscreenChatDock: true };
    const screen = await openLauncherOverATab();
    await expect.element(screen.getByTestId("panel-all-tabs")).toBeVisible();
    await expect.element(screen.getByTestId("panel-launcher-apps")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Full screen" })).toBeVisible();
    expect(document.querySelector('[aria-label="Opened by the agent"]')).not.toBeNull();
    await screen.getByTestId("panel-launcher-apps").click();
    // Nothing runs anywhere here: the empty state says how to get an app.
    await expect.element(screen.getByTestId("panel-launcher-apps-empty")).toBeVisible();
  });
});
