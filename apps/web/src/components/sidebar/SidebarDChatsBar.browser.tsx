import "../../index.css";

import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { TooltipProvider } from "../ui/tooltip";
import {
  LegacySidebarDChatsBar,
  SidebarDChatsBar,
  useSidebarDViewMenu,
  type SidebarDPickOption,
} from "./SidebarDChatsBar";
import { sidebarDTitle, toggleFilter } from "./sidebarDView.logic";

/**
 * The funnel in a real browser, on the same picks as the title's Projects
 * submenu, the way Sidebar.tsx holds them: clicks, the tick, reset, keys.
 */

const option = (name: string): SidebarDPickOption => ({
  key: name,
  label: name,
  projectIcon: (className) => <i data-testid={`icon-${name}`} className={className} />,
});
const THREE = ["landing", "api", "docs"].map(option);
const FIVE = [...THREE, option("mobile"), option("infra")];

function Bar(props: {
  projects: ReadonlyArray<SidebarDPickOption>;
  initial?: ReadonlyArray<string> | null;
}) {
  const [picked, setPicked] = useState<ReadonlyArray<string> | null>(props.initial ?? null);
  return (
    <TooltipProvider>
      <ul className="w-72">
        <SidebarDChatsBar
          title={sidebarDTitle({ projectNames: picked, computerNames: null })}
          groupInHeader
          levels={["status"]}
          multiComputer={false}
          onLevelsChange={() => {}}
          onOpenSettings={() => {}}
          snoozedCount={0}
          onShowSnoozed={() => {}}
          onOpenArchive={() => {}}
          projects={props.projects}
          filterProjects={props.projects}
          pickedProjects={picked}
          onProjectsChange={setPicked}
          computers={[]}
          pickedComputers={null}
          onComputersChange={() => {}}
          onlyMine={false}
          onOnlyMineChange={() => {}}
          onClearFilters={() => setPicked(null)}
          onNewChat={() => {}}
          newChatShortcutLabel={null}
          onAddProject={() => {}}
        />
      </ul>
      <output data-testid="picked">{JSON.stringify(picked)}</output>
    </TooltipProvider>
  );
}

const funnel = () => page.getByTestId("sidebar-d-project-filter");
const popup = () => page.getByTestId("sidebar-d-project-filter-popup");
const row = (name: string) => page.getByTestId(`sidebar-d-project-filter-${name}`);
const tick = (name: string) => page.getByTestId(`sidebar-d-project-filter-tick-${name}`);
const picked = () => page.getByTestId("picked");
const title = () => page.getByTestId("sidebar-d-view-trigger");

async function openFunnel() {
  await funnel().click();
  await expect.element(popup()).toBeVisible();
}

afterEach(() => {
  useSidebarDViewMenu.getState().setOpen(false);
  cleanup();
});

describe("the funnel", () => {
  it("a click keeps one project and closes: two clicks in all", async () => {
    await render(<Bar projects={THREE} />);
    await expect.element(page.getByTestId("sidebar-d-project-filter-funnel")).toBeVisible();
    await openFunnel();
    await row("api").click();
    await expect.element(picked()).toHaveTextContent('["api"]');
    await expect.element(popup()).not.toBeInTheDocument();
    await expect.element(title()).toHaveTextContent("Chats · api");
    // The funnel gives way to the project's icon.
    await expect.element(page.getByTestId("icon-api")).toBeVisible();
    expect(page.getByTestId("sidebar-d-project-filter-funnel").query()).toBeNull();
  });

  it("a click on a row among several picks keeps only that row", async () => {
    await render(<Bar projects={THREE} initial={["landing", "api"]} />);
    await openFunnel();
    await row("api").click();
    await expect.element(picked()).toHaveTextContent('["api"]');
    await expect.element(popup()).not.toBeInTheDocument();
  });

  it("the tick adds and takes away, and the popup stays", async () => {
    await render(<Bar projects={THREE} />);
    await openFunnel();
    await tick("landing").click();
    await expect.element(picked()).toHaveTextContent('["landing"]');
    await tick("api").click();
    await expect.element(picked()).toHaveTextContent('["landing","api"]');
    await expect.element(popup()).toBeVisible();
    await expect.element(tick("api")).toHaveAttribute("aria-pressed", "true");
    await expect.element(title()).toHaveTextContent("Chats · 2 projects");
    await tick("landing").click();
    await expect.element(picked()).toHaveTextContent('["api"]');
    await expect.element(popup()).toBeVisible();
  });

  it("two picks show two icons", async () => {
    await render(<Bar projects={THREE} initial={["landing", "docs"]} />);
    await expect.element(page.getByTestId("icon-landing")).toBeVisible();
    await expect.element(page.getByTestId("icon-docs")).toBeVisible();
    await expect.element(page.getByTestId("icon-api")).not.toBeInTheDocument();
  });

  it("Shift+click does what the tick does", async () => {
    await render(<Bar projects={THREE} initial={["landing"]} />);
    await openFunnel();
    await userEvent.keyboard("{Shift>}");
    await row("api").click();
    await userEvent.keyboard("{/Shift}");
    await expect.element(picked()).toHaveTextContent('["landing","api"]');
    await expect.element(popup()).toBeVisible();
  });

  it("Enter keeps one and closes, Shift+Enter adds and stays", async () => {
    await render(<Bar projects={THREE} />);
    await openFunnel();
    await userEvent.keyboard("{ArrowDown}{Shift>}{Enter}{/Shift}");
    await expect.element(picked()).toHaveTextContent('["landing"]');
    await expect.element(popup()).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Shift>}{Enter}{/Shift}");
    await expect.element(picked()).toHaveTextContent('["landing","api"]');
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await expect.element(picked()).toHaveTextContent('["docs"]');
    await expect.element(popup()).not.toBeInTheDocument();
  });

  it("All projects resets and closes", async () => {
    await render(<Bar projects={THREE} initial={["landing", "api"]} />);
    await openFunnel();
    await page.getByTestId("sidebar-d-project-filter-all").click();
    await expect.element(picked()).toHaveTextContent("null");
    await expect.element(popup()).not.toBeInTheDocument();
    await expect.element(title()).toHaveTextContent("All chats");
    await expect.element(page.getByTestId("sidebar-d-project-filter-funnel")).toBeVisible();
  });

  it("every project ticked is all projects again, as in the submenu", async () => {
    await render(<Bar projects={THREE} initial={["landing", "api"]} />);
    await openFunnel();
    await tick("docs").click();
    await expect.element(picked()).toHaveTextContent("null");
    expect(toggleFilter(["landing", "api"], "docs", ["landing", "api", "docs"])).toBeNull();
  });

  it("× clears what the funnel set", async () => {
    await render(<Bar projects={THREE} />);
    await openFunnel();
    await row("docs").click();
    await page.getByTestId("sidebar-d-clear-filter").click();
    await expect.element(picked()).toHaveTextContent("null");
    await expect.element(title()).toHaveTextContent("All chats");
  });

  it("a stored filter from before the funnel reads as it was", async () => {
    await render(<Bar projects={THREE} initial={["api"]} />);
    await expect.element(title()).toHaveTextContent("Chats · api");
    await openFunnel();
    await expect.element(tick("api")).toHaveAttribute("aria-pressed", "true");
    await expect.element(tick("docs")).toHaveAttribute("aria-pressed", "false");
  });

  it("the search stays out of sight with up to three projects", async () => {
    await render(<Bar projects={THREE} />);
    await openFunnel();
    const field = page.getByTestId("sidebar-d-project-filter-search");
    expect(field.element().getBoundingClientRect().width).toBeLessThanOrEqual(1);
  });

  it("from four projects the search is there and finds", async () => {
    await render(<Bar projects={FIVE} />);
    await openFunnel();
    const field = page.getByTestId("sidebar-d-project-filter-search");
    expect(field.element().getBoundingClientRect().width).toBeGreaterThan(50);
    await page.getByLabelText("Search projects").fill("inf");
    await expect.element(row("infra")).toBeVisible();
    await expect.element(row("landing")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("sidebar-d-project-filter-all")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await expect.element(picked()).toHaveTextContent('["infra"]');
  });

  it("is absent with one project", async () => {
    await render(<Bar projects={[option("landing")]} />);
    await expect.element(title()).toBeVisible();
    expect(funnel().query()).toBeNull();
  });

  it("is absent with the view menu's flag off", async () => {
    await render(
      <TooltipProvider>
        <ul>
          <LegacySidebarDChatsBar
            onNewChat={() => {}}
            newChatShortcutLabel={null}
            onAddProject={() => {}}
          />
        </ul>
      </TooltipProvider>,
    );
    await expect.element(page.getByTestId("sidebar-d-chats-bar")).toBeVisible();
    expect(funnel().query()).toBeNull();
  });
});

describe("the funnel and the title's Projects submenu", () => {
  async function openSubmenu() {
    await title().click();
    await page.getByTestId("sidebar-d-pick-project-trigger").click();
    await expect.element(page.getByTestId("sidebar-d-pick-project")).toBeVisible();
  }
  const menuRow = (name: string) => page.getByTestId(`sidebar-d-pick-project-${name}`);

  it("what the funnel picked is ticked in the submenu", async () => {
    await render(<Bar projects={THREE} />);
    await openFunnel();
    await row("api").click();
    await openSubmenu();
    await expect.element(menuRow("api")).toHaveAttribute("aria-checked", "true");
    await expect.element(menuRow("docs")).toHaveAttribute("aria-checked", "false");
    await expect
      .element(page.getByTestId("sidebar-d-pick-project-all"))
      .toHaveAttribute("aria-checked", "false");
  });

  it("what the submenu picked shows on the funnel", async () => {
    await render(<Bar projects={THREE} />);
    await openSubmenu();
    await menuRow("docs").click();
    await expect.element(picked()).toHaveTextContent('["docs"]');
    await userEvent.keyboard("{Escape}{Escape}");
    await expect.element(page.getByTestId("sidebar-d-pick-project")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("icon-docs")).toBeVisible();
    await openFunnel();
    await expect.element(tick("docs")).toHaveAttribute("aria-pressed", "true");
  });
});
