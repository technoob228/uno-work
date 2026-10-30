import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LegacySidebarDChatsBar, SidebarDChatsBar, newChatTooltipLabel } from "./SidebarDChatsBar";

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
  onlyMine: false,
  onOnlyMineChange: () => {},
  onOpenSettings: () => {},
  snoozedCount: 0,
  onShowSnoozed: () => {},
  onOpenArchive: () => {},
  onClearFilters: () => {},
  onNewChat: () => {},
  newChatShortcutLabel: "⌘N",
  onAddProject: () => {},
};

describe("LegacySidebarDChatsBar (Sidebar view menu off, as in 0.0.137)", () => {
  it("has New chat right before Add a project", () => {
    const html = renderToStaticMarkup(
      <LegacySidebarDChatsBar
        onNewChat={() => {}}
        newChatShortcutLabel="⌘N"
        onAddProject={() => {}}
      />,
    );
    const newChat = html.indexOf('data-testid="sidebar-d-new-chat"');
    const addProject = html.indexOf('data-testid="sidebar-d-add-project"');
    expect(newChat).toBeGreaterThan(-1);
    expect(addProject).toBeGreaterThan(newChat);
    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain('aria-label="Add a project"');
  });

  it("is the quiet Chats label, with no view menu", () => {
    const html = renderToStaticMarkup(
      <LegacySidebarDChatsBar
        onNewChat={() => {}}
        newChatShortcutLabel={null}
        onAddProject={() => {}}
      />,
    );
    expect(html).toContain(">Chats<");
    expect(html).not.toContain("sidebar-d-view-trigger");
    expect(html.match(/<button/g)?.length).toBe(2);
  });
});

describe("SidebarDChatsBar (Sidebar view menu on)", () => {
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

  it("Only mine counts as a filter: × clears it", () => {
    const html = renderToStaticMarkup(
      <SidebarDChatsBar {...base} title="My chats" onlyMine={true} />,
    );
    expect(html).toContain('data-testid="sidebar-d-clear-filter"');
    expect(html).toContain("My chats");
  });

  it("names the shortcut in the tooltip only when one is bound", () => {
    expect(newChatTooltipLabel("⌘N")).toBe("New chat ⌘N");
    expect(newChatTooltipLabel("Ctrl+N")).toBe("New chat Ctrl+N");
    expect(newChatTooltipLabel(null)).toBe("New chat");
  });
});
