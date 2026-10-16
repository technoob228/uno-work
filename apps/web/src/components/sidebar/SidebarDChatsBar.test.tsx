import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarDChatsBar, newChatTooltipLabel } from "./SidebarDChatsBar";

const base = {
  view: "projects" as const,
  title: "Projects",
  onViewChange: () => {},
  projectFilter: null,
  groupByComputer: null,
  onNewChat: () => {},
  newChatShortcutLabel: "⌘N",
  onAddProject: () => {},
};

describe("SidebarDChatsBar", () => {
  it("has Add a project, then New chat rightmost", () => {
    const html = renderToStaticMarkup(<SidebarDChatsBar {...base} viewInHeader />);
    const newChat = html.indexOf('data-testid="sidebar-d-new-chat"');
    const addProject = html.indexOf('data-testid="sidebar-d-add-project"');
    expect(addProject).toBeGreaterThan(-1);
    expect(newChat).toBeGreaterThan(addProject);
    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain('aria-label="Add a project"');
  });

  it("the title opens the view menu in the header variant", () => {
    const html = renderToStaticMarkup(<SidebarDChatsBar {...base} viewInHeader />);
    expect(html).toContain('data-testid="sidebar-d-view-trigger"');
    expect(html).not.toContain("Chats<");
  });

  it("in the Settings variant the title is plain text, except in one list", () => {
    const plain = renderToStaticMarkup(<SidebarDChatsBar {...base} viewInHeader={false} />);
    expect(plain).toContain('data-testid="sidebar-d-view-title"');
    expect(plain).not.toContain('data-testid="sidebar-d-view-trigger"');
    const list = renderToStaticMarkup(
      <SidebarDChatsBar
        {...base}
        view="list"
        title="All projects"
        viewInHeader={false}
        projectFilter={{ value: null, options: [{ key: null, label: "All projects" }], onChange: () => {} }}
      />,
    );
    expect(list).toContain('data-testid="sidebar-d-view-trigger"');
  });

  it("names the shortcut in the tooltip only when one is bound", () => {
    expect(newChatTooltipLabel("⌘N")).toBe("New chat ⌘N");
    expect(newChatTooltipLabel("Ctrl+N")).toBe("New chat Ctrl+N");
    expect(newChatTooltipLabel(null)).toBe("New chat");
  });
});
