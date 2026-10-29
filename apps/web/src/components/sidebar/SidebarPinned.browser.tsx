import "../../index.css";

import type { UnoMachineApp, UnoPin } from "@t3tools/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

/**
 * A pinned app with a Home widget shows it on hover (Misha 29.10): beside the
 * pin, with Open; it stays while the pointer moves onto it and goes once the
 * pointer leaves both. Apps without a widget and other pins: no card.
 */

const sales = {
  id: "sales",
  name: "Shop sales",
  icon: "📈",
  url: "http://localhost:8124",
  widget: { path: "/widget", size: "medium", title: "Sales today" },
} as unknown as UnoMachineApp;
const limits = {
  id: "limits",
  name: "AI limits",
  url: "http://localhost:8125",
} as unknown as UnoMachineApp;
const pins: UnoPin[] = [
  { id: "p1", kind: "app", title: "Shop sales", target: "http://localhost:8124/", icon: "📈" },
  { id: "p2", kind: "app", title: "AI limits", target: "http://localhost:8125/", icon: null },
  { id: "p3", kind: "folder", title: "Projects", target: "~/projects", icon: null },
];
const openHere = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => vi.fn(),
  useMatch: () => undefined,
  useLocation: (options?: { select?: (location: object) => unknown }) => {
    const location = { pathname: "/computer", search: {} };
    return options?.select ? options.select(location) : location;
  },
}));
vi.mock("../../navigation/usePins", () => ({
  usePins: () => ({ pins, unpin: vi.fn(), rename: vi.fn(), pin: vi.fn() }),
}));
vi.mock("../../navigation/useOpenApp", () => ({
  openInNewTab: vi.fn(),
  useOpenApp: () => ({ openHere, openBeside: vi.fn() }),
}));
vi.mock("../../navigation/useOpenComputerFile", () => ({ useOpenComputerFile: () => vi.fn() }));
vi.mock("../computer/useProgramTiles", () => ({
  useProgramTiles: () => ({
    tiles: [
      { machineApp: sales, openUrl: "http://localhost:8124/" },
      { machineApp: limits, openUrl: "http://localhost:8125/" },
    ],
    loading: false,
    hasStore: false,
  }),
}));
vi.mock("../../hooks/useActiveMachine", () => ({
  useActiveMachine: () => ({ environmentId: null }),
}));
vi.mock("../computer/home/HomeAppWidget", () => ({
  HomeAppWidget: (props: { app: UnoMachineApp }) => (
    <div data-testid="the-widget">{props.app.name}: 312 400 ₽</div>
  ),
}));

const { SidebarProvider } = await import("../ui/sidebar");
const { SidebarPinned } = await import("./SidebarPinned");

function mount() {
  return render(
    <SidebarProvider open onOpenChange={vi.fn()}>
      <div style={{ width: 256 }}>
        <SidebarPinned pinnedChats={null} hasPinnedChats={false} />
      </div>
      <div
        data-testid="elsewhere"
        style={{ position: "fixed", right: 0, bottom: 0, width: 200, height: 200 }}
      />
    </SidebarProvider>,
  );
}

const openCard = () => document.querySelector('[data-testid="pin-peek-card"][data-open="true"]');

beforeEach(async () => {
  await page.viewport(1280, 800);
});
afterEach(() => {
  openHere.mockReset();
});

describe("a pinned app's widget on hover", () => {
  it("shows the widget beside the pin, stays on it, goes when the pointer leaves", async () => {
    const screen = await mount();
    const row = screen.getByText("Shop sales", { exact: true });
    await userEvent.hover(row);
    await expect.poll(openCard).not.toBeNull();
    await expect.element(page.getByTestId("the-widget")).toHaveTextContent("Shop sales: 312 400 ₽");
    await expect.element(page.getByRole("dialog")).toHaveTextContent("Sales today");
    // Right of the pin, not over it.
    const card = openCard()!.getBoundingClientRect();
    expect(card.left).toBeGreaterThanOrEqual(row.element().getBoundingClientRect().right);

    // Onto the card: it stays, its Open works.
    await userEvent.hover(page.getByTestId("pin-peek-open"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(openCard()).not.toBeNull();
    await page.getByTestId("pin-peek-open").click();
    expect(openHere).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://localhost:8124/" }),
    );
    await expect.poll(openCard).toBeNull();
  });

  it("goes a moment after the pointer leaves the pin", async () => {
    const screen = await mount();
    await userEvent.hover(screen.getByText("Shop sales", { exact: true }));
    await expect.poll(openCard).not.toBeNull();
    await userEvent.hover(screen.getByTestId("elsewhere"));
    await expect.poll(openCard).toBeNull();
  });

  it("no card when a narrow window has no room beside the sidebar", async () => {
    await page.viewport(500, 800);
    const screen = await mount();
    await userEvent.hover(screen.getByText("Shop sales", { exact: true }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector('[data-testid="pin-peek-card"]')).toBeNull();
  });

  it("no card for an app without a widget, or a folder", async () => {
    const screen = await mount();
    await userEvent.hover(screen.getByText("AI limits"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector('[data-testid="pin-peek-card"]')).toBeNull();
    await userEvent.hover(screen.getByText("Projects"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(document.querySelector('[data-testid="pin-peek-card"]')).toBeNull();
  });
});
