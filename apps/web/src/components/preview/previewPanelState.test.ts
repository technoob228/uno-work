import { describe, expect, it } from "vitest";

import {
  closeTab,
  DEFAULT_PREVIEW_BUCKET_STATE,
  dropChatBuckets,
  getPreviewBucketState,
  isPanelOpen,
  moveTabScope,
  openBrowserTab,
  openTab,
  resolvePanelView,
  setPanelOpen,
  togglePanelOpen,
  updatePanelView,
  type PreviewStates,
} from "./previewPanelState";
import { chatScopeKey, GLOBAL_SCOPE_KEY, projectScopeKey } from "./previewTabScopes";
import type { PreviewFile } from "./PreviewPaneContext";

const chatA = { projectKey: "proj", threadId: "thread-a" };
const chatB = { projectKey: "proj", threadId: "thread-b" };
/** Home, Files, Apps, Settings… — любой экран, где нет основного чата. */
const home = { projectKey: "proj", threadId: null };

function file(id: string): PreviewFile {
  return { id, name: `${id}.md`, kind: "md", content: "" };
}

const report = file("report");
const notes = file("notes");

describe("tabs opened in a chat live in that chat", () => {
  it("an agent's first open_in_panel opens the panel in its chat", () => {
    const states = openTab({}, chatA, "chat", report, "agent");
    const view = resolvePanelView(states, chatA);
    expect(view.open).toBe(true);
    expect(view.visible).toBe(true);
    expect(view.view.activeFileId).toBe("report");
    expect(states[chatScopeKey("thread-a")]?.files).toEqual([report]);
  });

  it("Home does not show the chat's panel", () => {
    const states = openTab({}, chatA, "chat", report, "agent");
    const view = resolvePanelView(states, home);
    expect(view.files).toEqual([]);
    expect(view.visible).toBe(false);
  });

  it("another chat shows its own panel — hidden when it has no tabs", () => {
    const states = openTab({}, chatA, "chat", report, "agent");
    expect(resolvePanelView(states, chatB).visible).toBe(false);
  });

  it("coming back to the chat restores its panel, active tab and width", () => {
    let states = openTab({}, chatA, "chat", report, "agent");
    states = openTab(states, chatA, "chat", notes, "agent");
    states = updatePanelView(states, chatA, (view) => ({
      ...view,
      activeFileId: "report",
      width: 640,
      previewLayoutMode: "focus",
    }));
    // Уход на Home и в другой чат состояние чата A не трогает.
    states = setPanelOpen(states, chatB, false);
    const back = resolvePanelView(states, chatA);
    expect(back.visible).toBe(true);
    expect(back.view.activeFileId).toBe("report");
    expect(back.view.width).toBe(640);
    expect(back.view.previewLayoutMode).toBe("focus");
    expect(resolvePanelView(states, chatB).view.width).toBeNull();
  });

  it("each chat keeps its own open/closed state", () => {
    let states = openTab({}, chatA, "chat", report, "agent");
    states = openTab(states, chatB, "chat", notes, "agent");
    states = setPanelOpen(states, chatB, false);
    expect(isPanelOpen(states, chatA)).toBe(true);
    expect(isPanelOpen(states, chatB)).toBe(false);
  });

  it("an agent in a background chat prepares that chat's panel, not the visible one", () => {
    let states = openTab({}, chatA, "chat", report, "person");
    states = openTab(states, chatB, "chat", notes, "agent");
    expect(resolvePanelView(states, chatA).view.activeFileId).toBe("report");
    expect(resolvePanelView(states, chatB).visible).toBe(true);
  });
});

describe("a panel the person closed stays closed", () => {
  it("a new agent open adds the tab and raises the badge instead of opening", () => {
    let states = openTab({}, chatA, "chat", report, "agent");
    states = setPanelOpen(states, chatA, false);
    states = openTab(states, chatA, "chat", notes, "agent");
    const view = resolvePanelView(states, chatA);
    expect(view.open).toBe(false);
    expect(view.files.map((tab) => tab.id)).toEqual(["report", "notes"]);
    expect(view.view.unseen).toBe(1);
    // Открыл человек — видит новое, бейдж гаснет.
    states = togglePanelOpen(states, chatA);
    const shown = resolvePanelView(states, chatA);
    expect(shown.visible).toBe(true);
    expect(shown.view.activeFileId).toBe("notes");
    expect(shown.view.unseen).toBe(0);
  });

  it("the badge counts every agent open while closed, including re-focusing a tab", () => {
    let states = openTab({}, chatA, "chat", report, "agent");
    states = setPanelOpen(states, chatA, false);
    states = openTab(states, chatA, "chat", notes, "agent");
    states = openTab(states, chatA, "chat", report, "agent");
    expect(getPreviewBucketState(states, chatScopeKey("thread-a")).unseen).toBe(2);
  });

  it("closing the panel before anything opened also counts as the person's choice", () => {
    let states = setPanelOpen({}, chatA, false);
    states = openTab(states, chatA, "chat", report, "agent");
    expect(isPanelOpen(states, chatA)).toBe(false);
  });

  it("whatever the person opens always shows", () => {
    let states = openTab({}, chatA, "chat", report, "agent");
    states = setPanelOpen(states, chatA, false);
    states = openTab(states, chatA, "chat", notes, "person");
    expect(resolvePanelView(states, chatA).visible).toBe(true);
  });

  it("after the person reopens the panel the agent may show things again", () => {
    let states = openTab({}, chatA, "chat", report, "agent");
    states = setPanelOpen(states, chatA, false);
    states = setPanelOpen(states, chatA, true);
    states = openTab(states, chatA, "chat", notes, "agent");
    const view = resolvePanelView(states, chatA);
    expect(view.open).toBe(true);
    expect(view.view.activeFileId).toBe("notes");
  });

  it("the agent's browser tabs follow the same rule", () => {
    let counter = 0;
    const makeTab = (): PreviewFile => ({
      id: `browser-${++counter}`,
      name: "page",
      kind: "browser",
      content: "",
      url: "https://example.com/",
    });
    let states = openBrowserTab({}, chatA, "chat", "https://example.com/", makeTab, "agent");
    states = setPanelOpen(states, chatA, false);
    // Тот же адрес — вкладка не дублируется, но бейдж есть.
    states = openBrowserTab(states, chatA, "chat", "https://example.com/", makeTab, "agent");
    const view = resolvePanelView(states, chatA);
    expect(view.files).toHaveLength(1);
    expect(view.open).toBe(false);
    expect(view.view.unseen).toBe(1);
  });
});

describe("pinned everywhere", () => {
  it("is not the default for anything opened in a chat", () => {
    const states = openTab({}, chatA, "chat", report, "agent");
    expect(states[GLOBAL_SCOPE_KEY]).toBeUndefined();
  });

  it("a tab the person pins shows on Home and in chats where the panel wasn't touched", () => {
    let states = openTab({}, chatA, "chat", report, "person");
    states = moveTabScope(states, chatA, "report", "global");
    expect(resolvePanelView(states, home).visible).toBe(true);
    expect(resolvePanelView(states, home).files).toEqual([report]);
    expect(resolvePanelView(states, chatB).visible).toBe(true);
  });

  it("a chat where the person closed the panel keeps it closed even with pins", () => {
    let states = setPanelOpen({}, chatB, false);
    states = openTab(states, chatA, "chat", report, "person");
    states = moveTabScope(states, chatA, "report", "global");
    expect(resolvePanelView(states, chatB).visible).toBe(false);
  });

  it("closing the panel on Home hides pins there and in untouched chats", () => {
    let states = openTab({}, chatA, "chat", report, "person");
    states = moveTabScope(states, chatA, "report", "global");
    states = setPanelOpen(states, home, false);
    expect(resolvePanelView(states, home).visible).toBe(false);
    expect(resolvePanelView(states, chatB).visible).toBe(false);
    // Чат A панель уже трогал — у него свой вид.
    expect(resolvePanelView(states, chatA).visible).toBe(true);
  });

  it("something the person opens outside a chat is pinned so it can be seen there", () => {
    const states = openTab({}, home, "global", report, "person");
    expect(resolvePanelView(states, home).visible).toBe(true);
  });

  it("project tabs never show outside a chat", () => {
    const states = openTab({}, chatA, "project", report, "person");
    expect(resolvePanelView(states, home).visible).toBe(false);
    expect(states[projectScopeKey("proj")]?.files).toEqual([report]);
    // Но в соседнем чате проекта вкладка есть (панель там закрыта, пока не открыть).
    expect(resolvePanelView(states, chatB).files).toEqual([report]);
    expect(resolvePanelView(states, chatB).open).toBe(false);
  });

  it("a legacy agent without a thread does not open an empty panel on Home", () => {
    const states = openTab({}, home, "chat", report, "agent");
    expect(states[projectScopeKey("proj")]?.files).toEqual([report]);
    expect(getPreviewBucketState(states, GLOBAL_SCOPE_KEY).open).toBe(false);
  });
});

describe("migration from the global panel state of 0.0.104 and earlier", () => {
  it("restored pinned tabs without the v2 flag keep Home clear", () => {
    // Так выглядит состояние после перезапуска: вкладки из uno_preview_tabs_v1,
    // флага «показано» нет.
    const states: PreviewStates = {
      [GLOBAL_SCOPE_KEY]: { ...DEFAULT_PREVIEW_BUCKET_STATE, files: [report] },
      [projectScopeKey("proj")]: { ...DEFAULT_PREVIEW_BUCKET_STATE, files: [notes] },
    };
    expect(resolvePanelView(states, home).visible).toBe(false);
    expect(resolvePanelView(states, chatA).visible).toBe(false);
  });
});

describe("closeTab", () => {
  it("moves the active tab of the chat to the next visible one", () => {
    let states = openTab({}, chatA, "chat", report, "person");
    states = openTab(states, chatA, "chat", notes, "person");
    const result = closeTab(states, chatA, "notes");
    expect(result.closed).toEqual(notes);
    expect(resolvePanelView(result.states, chatA).view.activeFileId).toBe("report");
  });
});

describe("a chat marked Done or archived takes its panel with it", () => {
  it("drops the chat's tabs and view; other chats, project and pinned tabs stay", () => {
    let states = openTab({}, chatA, "chat", report, "agent");
    states = updatePanelView(states, chatA, (view) => ({ ...view, width: 640 }));
    states = openTab(states, chatB, "chat", notes, "agent");
    states = openTab(states, chatA, "project", file("dashboard"), "person");
    states = openTab(states, chatA, "global", file("pinned"), "person");

    const result = dropChatBuckets(states, ["thread-a"]);

    expect(result.states[chatScopeKey("thread-a")]).toBeUndefined();
    expect(result.dropped.map((tab) => tab.id)).toEqual(["report"]);
    expect(result.states[chatScopeKey("thread-b")]?.files).toEqual([notes]);
    expect(result.states[projectScopeKey("proj")]?.files.map((tab) => tab.id)).toEqual([
      "dashboard",
    ]);
    expect(result.states[GLOBAL_SCOPE_KEY]?.files.map((tab) => tab.id)).toEqual(["pinned"]);
  });

  it("a chat brought back from Done starts with an empty, untouched panel", () => {
    let states = openTab({}, chatA, "chat", report, "agent");
    states = setPanelOpen(states, chatA, false);
    states = dropChatBuckets(states, ["thread-a"]).states;
    const view = resolvePanelView(states, chatA);
    expect(view.files).toEqual([]);
    expect(view.visible).toBe(false);
    expect(view.view).toEqual(DEFAULT_PREVIEW_BUCKET_STATE);
    // Агент снова может открыть панель: «закрыто человеком» ушло вместе с чатом.
    states = openTab(states, chatA, "chat", notes, "agent");
    expect(resolvePanelView(states, chatA).visible).toBe(true);
  });

  it("a file also open in another chat is not reported as gone", () => {
    let states = openTab({}, chatA, "chat", report, "agent");
    states = openTab(states, chatB, "chat", report, "agent");
    const result = dropChatBuckets(states, ["thread-a"]);
    expect(result.dropped).toEqual([]);
    expect(result.states[chatScopeKey("thread-b")]?.files).toEqual([report]);
  });

  it("nothing to drop keeps the same object (no re-render)", () => {
    const states = openTab({}, chatB, "chat", notes, "agent");
    expect(dropChatBuckets(states, ["thread-a"]).states).toBe(states);
    expect(dropChatBuckets(states, []).states).toBe(states);
  });
});
