import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { openNewProject, useNewProjectStore } from "../../navigation/newProjectStore";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarAddProjectButton } from "./SidebarAddProjectButton";
import { LegacySidebarDChatsBar, SidebarDChatsBar } from "./SidebarDChatsBar";

/**
 * The full-width "Add a project" (Misha 28.10) opens the very dialog the small
 * folder icon on the chats bar opens: Sidebar.tsx hands both the same
 * handler, which ends in openNewProject().
 */

function dialogState() {
  const { open, step, wording, afterCreate, onCreated } = useNewProjectStore.getState();
  return { open, step, wording, afterCreate, onCreated };
}

const barProps = {
  title: "All chats",
  groupInHeader: true,
  levels: [],
  multiComputer: false,
  onLevelsChange: () => {},
  projects: [],
  pickedProjects: null,
  onProjectsChange: () => {},
  computers: [],
  pickedComputers: null,
  onComputersChange: () => {},
  onlyMine: false,
  onOnlyMineChange: () => {},
  onOpenSettings: () => {},
  onClearFilters: () => {},
  onNewChat: () => {},
  newChatShortcutLabel: "⌘N",
};

afterEach(() => {
  useNewProjectStore.getState().close();
});

describe("sidebar Add a project button", () => {
  it("opens the same Add a project dialog as the small folder icon", async () => {
    const onAddProject = () => openNewProject();
    const screen = await render(
      <TooltipProvider>
        <ul style={{ width: 272 }}>
          <SidebarDChatsBar {...barProps} onAddProject={onAddProject} />
          <SidebarAddProjectButton onAddProject={onAddProject} />
        </ul>
      </TooltipProvider>,
    );
    await expect.element(screen.getByTestId("sidebar-add-project-button")).toBeVisible();
    await expect
      .element(screen.getByTestId("sidebar-add-project-button"))
      .toHaveTextContent("Add a project");

    expect(useNewProjectStore.getState().open).toBe(false);
    await screen.getByTestId("sidebar-add-project-button").click();
    const fromButton = dialogState();
    expect(fromButton).toEqual({
      open: true,
      step: "choose",
      wording: "project",
      afterCreate: null,
      onCreated: null,
    });

    useNewProjectStore.getState().close();
    await screen.getByTestId("sidebar-d-add-project").click();
    expect(dialogState()).toEqual(fromButton);
  });

  it("fits a narrow sidebar without spilling over (the hint truncates)", async () => {
    const screen = await render(
      <TooltipProvider>
        <ul style={{ width: 200 }}>
          <LegacySidebarDChatsBar
            onNewChat={() => {}}
            newChatShortcutLabel={null}
            onAddProject={() => {}}
          />
          <SidebarAddProjectButton onAddProject={() => {}} />
        </ul>
      </TooltipProvider>,
    );
    const button = screen.getByTestId("sidebar-add-project-button").element() as HTMLElement;
    expect(button.getBoundingClientRect().width).toBeLessThanOrEqual(200);
    expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
  });
});
