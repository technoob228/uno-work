import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidebarDChatsBar, newChatTooltipLabel } from "./SidebarDChatsBar";

describe("SidebarDChatsBar", () => {
  it("has New chat right before Add a project", () => {
    const html = renderToStaticMarkup(
      <SidebarDChatsBar onNewChat={() => {}} newChatShortcutLabel="⌘N" onAddProject={() => {}} />,
    );
    const newChat = html.indexOf('data-testid="sidebar-d-new-chat"');
    const addProject = html.indexOf('data-testid="sidebar-d-add-project"');
    expect(newChat).toBeGreaterThan(-1);
    expect(addProject).toBeGreaterThan(newChat);
    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain('aria-label="Add a project"');
  });

  it("names the shortcut in the tooltip only when one is bound", () => {
    expect(newChatTooltipLabel("⌘N")).toBe("New chat ⌘N");
    expect(newChatTooltipLabel("Ctrl+N")).toBe("New chat Ctrl+N");
    expect(newChatTooltipLabel(null)).toBe("New chat");
  });
});
