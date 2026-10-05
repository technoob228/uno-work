import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

/**
 * Web lite's sidebar (lite/LiteShell) in a real browser: it is sidebar D —
 * the account button and New chat on top, the chats below — and everything
 * else lives in the account menu. No "My Uno" / "Free with Uno" groups, no
 * Plus upsell, no "in the browser" badge.
 *
 * VITE_LITE_SIDEBAR_SHOTS=<dir> also writes the screenshots for the report.
 */

const navigate = vi.fn();
let pathname = "/ai";
let chatParam: string | undefined = "c1";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigate,
  useSearch: () => (chatParam ? { chat: chatParam } : {}),
  useLocation: (options?: { select?: (location: { pathname: string }) => unknown }) =>
    options?.select ? options.select({ pathname }) : { pathname },
  Link: ({ to: _to, search: _search, ...rest }: Record<string, unknown>) => <a {...rest} />,
}));
vi.mock("../../navigation/useGoHome", () => ({ useGoHome: () => vi.fn() }));
vi.mock("../../inbox/inboxStore", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useInboxUnreadCount: () => 0,
  useInboxNeedsYouCount: () => 0,
  useInboxEntries: () => [],
}));

const { SidebarProvider, Sidebar, SidebarGroup } = await import("../ui/sidebar");
const { LiteSidebar } = await import("../../lite/LiteShell");
const { SidebarDHeader, SidebarDPlaces } = await import("./SidebarDParts");

const shotDir = import.meta.env.VITE_LITE_SIDEBAR_SHOTS as string | undefined;

function client(opts: {
  chats: ReadonlyArray<{ id: string; title: string }>;
  subscription?: unknown;
  features?: string[];
}) {
  const qc = new QueryClient();
  qc.setQueryData(["workspace", "myUno", "subscription"], opts.subscription ?? null);
  qc.setQueryData(["workspace", "myUno", "balance"], {
    email: "mikhail@productera.io",
    username: "uno_2512",
    features: opts.features ?? ["work_ai"],
  });
  qc.setQueryData(["workspace", "unoAi", "chats"], {
    chats: opts.chats.map((c) => ({ ...c, updated_at: new Date().toISOString(), sites: [] })),
    retentionDays: null,
  });
  return qc;
}

function Frame(props: { qc: QueryClient; children: React.ReactNode; main?: React.ReactNode }) {
  return (
    <QueryClientProvider client={props.qc}>
      <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
        <Sidebar
          side="left"
          collapsible="offcanvas"
          className="border-r border-border bg-card text-foreground"
        >
          {props.children}
        </Sidebar>
        <main className="flex flex-1 flex-col items-center justify-end p-6 pb-4 text-xs text-muted-foreground">
          {props.main ?? "Free Uno AI · 59 min left · Manage in console"}
        </main>
      </SidebarProvider>
    </QueryClientProvider>
  );
}

const CHATS = [
  { id: "c1", title: "An AI assistant for my work" },
  { id: "c2", title: "Landing page for my bakery" },
  { id: "c3", title: "Telegram bot that books tables" },
];

beforeEach(() => {
  document.documentElement.classList.add("dark");
  navigate.mockReset();
  pathname = "/ai";
  chatParam = "c1";
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("web lite sidebar = sidebar D", () => {
  it("shows the account button, New chat and the chats — nothing else", async () => {
    await page.viewport(1300, 740);
    render(
      <Frame qc={client({ chats: CHATS })}>
        <LiteSidebar />
      </Frame>,
    );
    await expect.element(page.getByText("Landing page for my bakery")).toBeVisible();
    await expect.element(page.getByTestId("sidebar-account")).toHaveTextContent("Uno Work");
    await expect.element(page.getByTestId("sidebar-header-new-chat")).toBeVisible();
    expect(page.getByTestId("lite-chat-row").elements()).toHaveLength(3);
    // The open chat is the highlighted row.
    expect(page.getByTestId("lite-chat-row").elements()[0]?.getAttribute("aria-current")).toBe(
      "page",
    );
    for (const gone of [
      "My Uno",
      "Free with Uno",
      "in the browser",
      "Get it — from Plus",
      "Computers",
      "Publish a website",
    ]) {
      expect(page.getByText(gone, { exact: true }).elements()).toHaveLength(0);
    }
    if (shotDir) await page.screenshot({ path: `${shotDir}/after-1-lite-sidebar.png` });
  });

  it("keeps everything else in the account menu", async () => {
    await page.viewport(1300, 740);
    render(
      <Frame qc={client({ chats: CHATS })}>
        <LiteSidebar />
      </Frame>,
    );
    await userEvent.click(page.getByTestId("sidebar-account"));
    const menu = page.getByTestId("sidebar-account-menu");
    await expect.element(menu).toBeVisible();
    await expect.element(menu).toHaveTextContent("mikhail@productera.io");
    await expect.element(menu).toHaveTextContent("Free");
    for (const item of [
      "Plan & billing",
      "Computers",
      "Sites",
      "Cloud storage",
      "Download Uno Work",
      "Connect your own AI",
      "Uno console",
      "Help",
      "Sign out",
    ]) {
      await expect.element(menu.getByText(item, { exact: true })).toBeVisible();
    }
    // Free has nothing to open in the cloud yet.
    expect(page.getByTestId("lite-open-cloud").elements()).toHaveLength(0);
    if (shotDir) await page.screenshot({ path: `${shotDir}/after-2-account-menu.png` });

    await userEvent.click(menu.getByText("Plan & billing", { exact: true }));
    expect(navigate).toHaveBeenCalledWith({ to: "/my-uno", search: { tab: "billing" } });
  });

  it("a plan with Uno Work in the cloud and no machine yet: Open it, first in the menu", async () => {
    render(
      <Frame
        qc={client({
          chats: CHATS,
          subscription: { plan: "plus", limits: { cloudWork: true, baseSlug: "plus" } },
        })}
      >
        <LiteSidebar />
      </Frame>,
    );
    await userEvent.click(page.getByTestId("sidebar-account"));
    await expect.element(page.getByTestId("lite-open-cloud")).toBeVisible();
  });

  it("New chat opens a fresh Uno AI chat", async () => {
    render(
      <Frame qc={client({ chats: CHATS })}>
        <LiteSidebar />
      </Frame>,
    );
    await userEvent.click(page.getByTestId("sidebar-header-new-chat"));
    expect(navigate).toHaveBeenCalledWith({ to: "/ai", search: {} });
  });

  it("no chats yet: one quiet New chat, as in the full app", async () => {
    await page.viewport(1300, 740);
    chatParam = undefined;
    render(
      <Frame qc={client({ chats: [] })}>
        <LiteSidebar />
      </Frame>,
    );
    await expect.element(page.getByTestId("lite-chats-empty")).toHaveTextContent("No chats yet");
    if (shotDir) await page.screenshot({ path: `${shotDir}/after-3-no-chats.png` });
  });

  it("before the work_ai rollout: no chats, no New chat — My Uno is the home", async () => {
    pathname = "/my-uno";
    render(
      <Frame qc={client({ chats: CHATS, features: [] })}>
        <LiteSidebar />
      </Frame>,
    );
    await expect.element(page.getByTestId("sidebar-account")).toBeVisible();
    expect(page.getByTestId("sidebar-header-new-chat").elements()).toHaveLength(0);
    expect(page.getByTestId("lite-chat-row").elements()).toHaveLength(0);
  });

  it("for comparison: the full app's sidebar D head (screenshot only)", async () => {
    if (!shotDir) return;
    await page.viewport(1300, 740);
    render(
      <Frame qc={client({ chats: [] })} main="Full Uno Work (with a computer), for comparison">
        <SidebarDHeader isElectron={false} />
        <SidebarGroup className="shrink-0 px-[var(--sidebar-content-inset)] pt-0.5 pb-1">
          <SidebarDPlaces />
        </SidebarGroup>
        <ul className="flex flex-col gap-px px-2 pt-1">
          {["Uno", ...CHATS.map((c) => c.title)].map((title, index) => (
            <li
              key={title}
              className={
                "flex h-8 items-center rounded-md pl-2.5 text-sm " +
                (index === 1
                  ? "bg-sidebar-row-active text-foreground"
                  : "text-sidebar-foreground/90")
              }
            >
              {title}
            </li>
          ))}
        </ul>
      </Frame>,
    );
    await expect.element(page.getByTestId("sidebar-places")).toBeVisible();
    await page.screenshot({ path: `${shotDir}/ref-full-sidebar-d.png` });
  });
});
