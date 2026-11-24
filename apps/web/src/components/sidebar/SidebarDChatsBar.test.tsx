import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LegacySidebarDChatsBar,
  SidebarDChatsBar,
  SidebarDNewChatButton,
} from "./SidebarDChatsBar";

const base = {
  title: "All chats",
  groupInHeader: true,
  levels: [],
  multiComputer: false,
  onLevelsChange: () => {},
  projects: [],
  filterProjects: [],
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
  onAddProject: () => {},
};

describe("LegacySidebarDChatsBar (Sidebar view menu off, as in 0.0.137)", () => {
  it("is the quiet Chats label and Add a project — New chat is the button under it (T65)", () => {
    const html = renderToStaticMarkup(<LegacySidebarDChatsBar onAddProject={() => {}} />);
    expect(html).toContain(">Chats<");
    expect(html).toContain('aria-label="Add a project"');
    expect(html).not.toContain("sidebar-d-new-chat");
    expect(html).not.toContain("sidebar-d-view-trigger");
    expect(html).not.toContain("sidebar-d-project-filter");
    expect(html.match(/<button/g)?.length).toBe(1);
  });
});

describe("SidebarDChatsBar (Sidebar view menu on)", () => {
  it("has the title menu and Add a project — no pencil since T65, nothing else", () => {
    const html = renderToStaticMarkup(<SidebarDChatsBar {...base} />);
    const trigger = html.indexOf('data-testid="sidebar-d-view-trigger"');
    const addProject = html.indexOf('data-testid="sidebar-d-add-project"');
    expect(trigger).toBeGreaterThan(-1);
    expect(addProject).toBeGreaterThan(trigger);
    expect(html).not.toContain("sidebar-d-new-chat");
    expect(html.match(/<button/g)?.length).toBe(2);
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

  it("has the funnel by the title only with something to filter", () => {
    const one = [{ key: "landing", label: "landing" }];
    const two = [...one, { key: "api", label: "api" }];
    const funnel = 'data-testid="sidebar-d-project-filter"';
    expect(renderToStaticMarkup(<SidebarDChatsBar {...base} />)).not.toContain(funnel);
    expect(renderToStaticMarkup(<SidebarDChatsBar {...base} filterProjects={one} />)).not.toContain(
      funnel,
    );
    const html = renderToStaticMarkup(<SidebarDChatsBar {...base} filterProjects={two} />);
    expect(html.indexOf(funnel)).toBeGreaterThan(html.indexOf("sidebar-d-view-trigger"));
    expect(html.indexOf(funnel)).toBeLessThan(html.indexOf("sidebar-d-add-project"));
  });
});

describe("SidebarDNewChatButton (T65, Misha 24.11)", () => {
  it('says "New chat" in words, with the shortcut when one is bound', () => {
    const html = renderToStaticMarkup(
      <SidebarDNewChatButton onNewChat={() => {}} newChatShortcutLabel="⌘N" />,
    );
    expect(html).toContain('data-testid="sidebar-d-new-chat"');
    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain("New chat");
    expect(html).toContain("⌘N");
    expect(html.match(/<button/g)?.length).toBe(1);
  });

  it("has no shortcut hint when none is bound", () => {
    const html = renderToStaticMarkup(
      <SidebarDNewChatButton onNewChat={() => {}} newChatShortcutLabel={null} />,
    );
    expect(html).not.toContain("<kbd");
  });
});
