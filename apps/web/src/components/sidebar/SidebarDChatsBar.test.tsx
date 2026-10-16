import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarDChatsBar, newChatTooltipLabel } from "./SidebarDChatsBar";

const base = {
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
  onOpenSettings: () => {},
  onClearFilters: () => {},
  onNewChat: () => {},
  newChatShortcutLabel: "⌘N",
  onAddProject: () => {},
};

describe("SidebarDChatsBar", () => {
  it("has the title menu, Add a project, then New chat rightmost — nothing else", () => {
    const html = renderToStaticMarkup(<SidebarDChatsBar {...base} />);
    const trigger = html.indexOf('data-testid="sidebar-d-view-trigger"');
    const addProject = html.indexOf('data-testid="sidebar-d-add-project"');
    const newChat = html.indexOf('data-testid="sidebar-d-new-chat"');
    expect(trigger).toBeGreaterThan(-1);
    expect(addProject).toBeGreaterThan(trigger);
    expect(newChat).toBeGreaterThan(addProject);
    expect(html.match(/<button/g)?.length).toBe(3);
    expect(html).toContain("All chats");
  });

  it("says the filter in the title only, with × to clear it", () => {
    expect(renderToStaticMarkup(<SidebarDChatsBar {...base} />)).not.toContain(
      "sidebar-d-clear-filter",
    );
    const html = renderToStaticMarkup(
      <SidebarDChatsBar {...base} title="Chats · landing" pickedProjects={["landing"]} />,
    );
    expect(html).toContain('data-testid="sidebar-d-clear-filter"');
    expect(html.split(">Chats · landing<").length - 1).toBe(1);
  });

  it("names the shortcut in the tooltip only when one is bound", () => {
    expect(newChatTooltipLabel("⌘N")).toBe("New chat ⌘N");
    expect(newChatTooltipLabel("Ctrl+N")).toBe("New chat Ctrl+N");
    expect(newChatTooltipLabel(null)).toBe("New chat");
  });
});
