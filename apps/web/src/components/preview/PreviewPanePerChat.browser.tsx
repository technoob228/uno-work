import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

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

function App() {
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
