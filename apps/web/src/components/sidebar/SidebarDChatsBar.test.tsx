import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarDChatsBar, newChatTooltipLabel } from "./SidebarDChatsBar";

const base = {
  title: "All projects",
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
  filterChip: null,
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
  });

  it("shows one filter chip only while a filter is on", () => {
    expect(renderToStaticMarkup(<SidebarDChatsBar {...base} />)).not.toContain(
      "sidebar-d-filter-chip",
    );
    const html = renderToStaticMarkup(
      <SidebarDChatsBar {...base} title="landing" filterChip="landing · MacBook" />,
    );
    expect(html).toContain('data-testid="sidebar-d-filter-chip"');
    expect(html).toContain("landing · MacBook");
  });

  it("names the shortcut in the tooltip only when one is bound", () => {
    expect(newChatTooltipLabel("⌘N")).toBe("New chat ⌘N");
    expect(newChatTooltipLabel("Ctrl+N")).toBe("New chat Ctrl+N");
    expect(newChatTooltipLabel(null)).toBe("New chat");
  });
});
