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
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { CHAT_DOCK_INSET_VAR, type ChatDockMode } from "../chat/chatDock.logic";
import { useChatDockInset } from "../chat/useChatDockInset";
import { SidebarProvider } from "../ui/sidebar";
import { PreviewPane } from "./PreviewPane";
import { PreviewPaneProvider, useChatPanelContext, usePreviewPane } from "./PreviewPaneContext";

/**
 * P1 (28.10, Misha's walkthrough): a tab on the whole window, "Hide chat",
 * back, then the panel's ✕. The real PreviewPaneProvider + PreviewPane; the
 * chat is a stand-in wired the way ChatView is: its header shows only outside
 * full screen, the dock block sits fixed at the bottom and keeps the inset
 * variable with the same hook.
 */

const DOCK_HEIGHT = 80;

function Chat() {
  useChatPanelContext({
    projectKey: "proj",
    projectCwd: "/home/me/proj",
    projectId: null,
    environmentId: null,
    threadId: "thread-a",
  });
  const { previewLayoutMode, openFile, toggleOpen, open } = usePreviewPane();
  const focus = previewLayoutMode === "focus";
  const [mode, setMode] = useState<ChatDockMode>("peek");
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  useChatDockInset(dock, { active: focus, mode });
  return (
    <div>
      {focus ? null : (
        <header data-testid="chat-header">
          <button type="button" onClick={toggleOpen}>
            Panel {open ? "open" : "closed"}
          </button>
        </header>
      )}
      <button
        type="button"
        onClick={() =>
          openFile({ id: "readme", name: "README.md", kind: "md", content: "# Notetaker" })
        }
      >
        open README
      </button>
      {mode === "minimized" ? (
        <button
          type="button"
          data-testid="mini-pill"
          className="fixed right-4 bottom-4 z-[70]"
          onClick={() => setMode("peek")}
        >
          Show chat
        </button>
      ) : null}
      <div
        ref={setDock}
        data-testid="dock"
        // Like ChatView's composer: above the full-screen pane (z-50).
        className={focus ? "fixed right-0 bottom-0 left-0 z-[70]" : undefined}
        style={{ height: DOCK_HEIGHT, display: mode === "minimized" ? "none" : undefined }}
      >
        {focus ? (
          <button type="button" onClick={() => setMode("minimized")}>
            Hide chat
          </button>
        ) : null}
      </div>
    </div>
  );
}

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
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <PreviewPaneProvider>
        <SidebarProvider defaultOpen={false}>
          <main className="flex-1">
            <Chat />
          </main>
          <PreviewPane />
        </SidebarProvider>
      </PreviewPaneProvider>
    </QueryClientProvider>
  );
}

function paneBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>('aside[aria-hidden="false"] [data-preview-pane-body]');
}

/** The room the tab leaves at the bottom; null — the panel isn't on screen. */
function reservedBottom(): number | null {
  const body = paneBody();
  return body ? Number.parseFloat(getComputedStyle(body).paddingBottom) : null;
}

describe("a tab on the whole window and the chat dock (P1, 28.10)", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    document.documentElement.style.removeProperty(CHAT_DOCK_INSET_VAR);
    await page.viewport(1280, 800);
  });

  it("leaves exactly the dock's room, none while the chat is hidden, and the ✕ brings the chat back", async () => {
    const screen = await render(<App />);
    await screen.getByRole("button", { name: "open README" }).click();
    await expect.poll(() => paneBody() !== null).toBe(true);
    expect(reservedBottom()).toBe(0);

    await screen.getByRole("button", { name: "Full screen", exact: true }).click();
    await expect.element(screen.getByTestId("chat-header")).not.toBeInTheDocument();
    // The dock's height plus a hair — not a fixed 9rem.
    await expect.poll(reservedBottom).toBe(DOCK_HEIGHT + 8);

    await screen.getByRole("button", { name: "Hide chat" }).click();
    // Hidden chat: the tab goes all the way down, no blank strip.
    await expect.poll(reservedBottom).toBe(0);

    await screen.getByTestId("mini-pill").click();
    await expect.poll(reservedBottom).toBe(DOCK_HEIGHT + 8);

    // The panel's ✕ on full screen: the chat is a chat again — its header
    // (with Panel) is back and nothing is left docked at the bottom.
    await screen.getByRole("button", { name: "Close panel" }).click();
    await expect.poll(paneBody).toBeNull();
    await expect.element(screen.getByTestId("chat-header")).toBeVisible();
    expect(document.documentElement.style.getPropertyValue(CHAT_DOCK_INSET_VAR)).toBe("");

    // Opened again — beside the chat, not over it.
    await screen.getByRole("button", { name: "Panel closed" }).click();
    await expect.poll(() => paneBody() !== null).toBe(true);
    await expect.element(screen.getByTestId("chat-header")).toBeVisible();
    expect(reservedBottom()).toBe(0);
  });
});
