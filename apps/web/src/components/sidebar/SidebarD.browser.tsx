import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

/**
 * Sidebar D's own pieces in a real browser: the places (Needs you only when
 * something waits), the collapsed rail and its slide-out timing, the expand
 * button and the account menu. The chat list itself is Sidebar.tsx (its
 * grouping is unit-tested in sidebarD.test.ts).
 */

const navigate = vi.fn();
const goHome = vi.fn();
let pathname = "/computer";
let unread = 0;
let needsYou = 0;

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigate,
  useLocation: (options?: { select?: (location: { pathname: string }) => unknown }) =>
    options?.select ? options.select({ pathname }) : { pathname },
}));
vi.mock("../../navigation/useGoHome", () => ({ useGoHome: () => goHome }));
vi.mock("../../inbox/inboxStore", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useInboxUnreadCount: () => unread,
  useInboxNeedsYouCount: () => needsYou,
  useInboxEntries: () => [],
}));

const { SidebarProvider } = await import("../ui/sidebar");
const { SidebarDAccountMenu, SidebarDPlaces, SidebarDRail, UnoFace } =
  await import("./SidebarDParts");
const { sidebarDPanel, useSidebarDPanelDismiss, useSidebarDStore } =
  await import("./sidebarDState");

/** What Sidebar.tsx does around the rail: Esc and a click into the page hide the panel. */
function PanelDismiss() {
  const open = useSidebarDStore((state) => state.panelOpen);
  useSidebarDPanelDismiss({ active: open, panelRef: { current: null } });
  return null;
}

function mount(children: React.ReactNode, onOpenChange = vi.fn()) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider open={false} onOpenChange={onOpenChange}>
        {children}
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  pathname = "/computer";
  unread = 0;
  needsYou = 0;
  navigate.mockReset();
  goHome.mockReset();
  sidebarDPanel.closeNow();
});
afterEach(() => {
  sidebarDPanel.closeNow();
});

describe("sidebar D places", () => {
  it("shows Files and Apps & sites, and no Needs you when nothing waits", async () => {
    const screen = await mount(<SidebarDPlaces />);
    await expect.element(screen.getByTestId("sidebar-nav-files")).toHaveTextContent("Files");
    await expect.element(screen.getByTestId("sidebar-nav-apps")).toHaveTextContent("Apps & sites");
    expect(screen.getByTestId("sidebar-needs-you").query()).toBeNull();
    // No Assistants and no Sites row of their own any more.
    expect(screen.getByText("Assistants").query()).toBeNull();
  });

  it("counts what waits on Needs you", async () => {
    unread = 2;
    needsYou = 2;
    const again = await mount(<SidebarDPlaces />);
    await expect.element(again.getByTestId("sidebar-needs-you")).toHaveTextContent("Needs you");
    await expect.element(again.getByTestId("sidebar-needs-you")).toHaveTextContent("2");
  });

  it("opens Files and Apps & sites as places", async () => {
    const screen = await mount(<SidebarDPlaces />);
    await screen.getByTestId("sidebar-nav-apps").click();
    expect(navigate).toHaveBeenCalledWith({ to: "/sites" });
    await screen.getByTestId("sidebar-nav-files").click();
    expect(navigate).toHaveBeenCalledWith({ to: "/files" });
  });

  it("lights Apps & sites on its page", async () => {
    pathname = "/sites";
    const screen = await mount(<SidebarDPlaces />);
    await expect
      .element(screen.getByTestId("sidebar-nav-apps"))
      .toHaveAttribute("aria-current", "page");
  });
});

describe("sidebar D collapsed rail", () => {
  it("slides the chats panel out after resting on Uno, and back after leaving", async () => {
    const screen = await mount(<SidebarDRail isElectron={false} />);
    await expect.element(screen.getByTestId("sidebar-rail")).toBeVisible();
    await userEvent.hover(screen.getByTestId("sidebar-rail-uno"));
    expect(useSidebarDStore.getState().panelOpen).toBe(false);
    await vi.waitFor(() => expect(useSidebarDStore.getState().panelOpen).toBe(true), {
      timeout: 1000,
    });
    await userEvent.hover(screen.getByTestId("sidebar-rail-files"));
    await vi.waitFor(() => expect(useSidebarDStore.getState().panelOpen).toBe(false), {
      timeout: 1500,
    });
  });

  it("Esc hides the panel while the pointer still rests on the icon that opened it", async () => {
    const screen = await mount(
      <>
        <SidebarDRail isElectron={false} />
        <PanelDismiss />
      </>,
    );
    const uno = screen.getByTestId("sidebar-rail-uno");
    await uno.hover();
    await vi.waitFor(() => expect(useSidebarDStore.getState().panelOpen).toBe(true));
    // The icon's tooltip is open now: it used to swallow Esc.
    await expect.element(page.getByText("Uno and its chats")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(useSidebarDStore.getState().panelOpen).toBe(false));
  });

  it("opens the panel at once on a click on Chats; files just open", async () => {
    const screen = await mount(<SidebarDRail isElectron={false} />);
    await screen.getByTestId("sidebar-rail-chats").click();
    expect(useSidebarDStore.getState().panelOpen).toBe(true);
    await screen.getByTestId("sidebar-rail-files").click();
    expect(navigate).toHaveBeenCalledWith({ to: "/files" });
    // Opening a place closes the panel.
    expect(useSidebarDStore.getState().panelOpen).toBe(false);
  });

  it("expands back to the full sidebar", async () => {
    const onOpenChange = vi.fn();
    const screen = await mount(<SidebarDRail isElectron={false} />, onOpenChange);
    await screen.getByTestId("sidebar-expand").click();
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("New chat goes to the start screen", async () => {
    const screen = await mount(<SidebarDRail isElectron={false} />);
    await screen.getByTestId("sidebar-rail-new-chat").click();
    expect(goHome).toHaveBeenCalled();
  });
});

describe("sidebar D account menu", () => {
  it("holds Settings and Help (the old footer)", async () => {
    const screen = await mount(<SidebarDAccountMenu computerName="uno-work" variant="header" />);
    await expect.element(screen.getByTestId("sidebar-account")).toHaveTextContent("uno-work");
    await screen.getByTestId("sidebar-account").click();
    const menu = page.getByTestId("sidebar-account-menu");
    await expect.element(menu).toHaveTextContent("Settings");
    await expect.element(menu).toHaveTextContent("Help");
    await page.getByRole("menuitem", { name: "Settings" }).click();
    expect(navigate).toHaveBeenCalledWith({ to: "/settings" });
  });
});

describe("Uno's face", () => {
  it("draws the face with an online dot", async () => {
    const screen = await render(<UnoFace online title="Uno" />);
    await expect.element(screen.getByRole("img", { name: "Uno" })).toBeVisible();
  });
});
