import { describe, expect, it } from "vitest";

import {
  automationScopeKeys,
  chatScopeKey,
  GLOBAL_SCOPE_KEY,
  projectScopeKey,
  scopeKeyForTarget,
  scopeOfKey,
  viewScopeKey,
  visibleScopeKeys,
} from "./previewTabScopes";
import {
  collectVisibleTabs,
  DEFAULT_PREVIEW_BUCKET_STATE,
  findTabScopeKey,
  type PreviewBucketState,
  type PreviewFile,
} from "./PreviewPaneContext";
import { collectPersistableTabs, restoreTabs } from "./previewTabPersistence";

const target = { projectKey: "proj-a", threadId: "thread-1" };

function bucket(files: ReadonlyArray<PreviewFile>): PreviewBucketState {
  return { ...DEFAULT_PREVIEW_BUCKET_STATE, files };
}

function browserTab(id: string, url: string): PreviewFile {
  return { id, name: id, kind: "browser", content: "", url };
}

describe("scopeKeyForTarget", () => {
  it("maps each level to its own bucket", () => {
    expect(scopeKeyForTarget(target, "global")).toBe(GLOBAL_SCOPE_KEY);
    expect(scopeKeyForTarget(target, "project")).toBe(projectScopeKey("proj-a"));
    expect(scopeKeyForTarget(target, "chat")).toBe(chatScopeKey("thread-1"));
  });

  it("falls back to the project bucket when no thread is active", () => {
    expect(scopeKeyForTarget({ projectKey: "proj-a", threadId: null }, "chat")).toBe(
      projectScopeKey("proj-a"),
    );
  });
});

describe("scopeOfKey", () => {
  it("round-trips every level", () => {
    expect(scopeOfKey(GLOBAL_SCOPE_KEY)).toBe("global");
    expect(scopeOfKey(projectScopeKey("x"))).toBe("project");
    expect(scopeOfKey(chatScopeKey("t"))).toBe("chat");
  });
});

describe("visibleScopeKeys", () => {
  it("orders buckets global → project → chat", () => {
    expect(visibleScopeKeys(target)).toEqual([
      GLOBAL_SCOPE_KEY,
      projectScopeKey("proj-a"),
      chatScopeKey("thread-1"),
    ]);
  });

  it("omits the chat bucket without an active thread", () => {
    expect(visibleScopeKeys({ projectKey: "proj-a", threadId: null })).toEqual([
      GLOBAL_SCOPE_KEY,
      projectScopeKey("proj-a"),
    ]);
  });

  it("automation prefers the chat bucket over project and global", () => {
    expect(automationScopeKeys(target)[0]).toBe(chatScopeKey("thread-1"));
  });

  it("view state lives in the project bucket", () => {
    expect(viewScopeKey(target)).toBe(projectScopeKey("proj-a"));
  });
});

describe("collectVisibleTabs", () => {
  const states: Record<string, PreviewBucketState> = {
    [GLOBAL_SCOPE_KEY]: bucket([browserTab("g1", "https://global.example")]),
    [projectScopeKey("proj-a")]: bucket([browserTab("p1", "https://project.example")]),
    [chatScopeKey("thread-1")]: bucket([browserTab("c1", "https://chat-1.example")]),
    [chatScopeKey("thread-2")]: bucket([browserTab("c2", "https://chat-2.example")]),
    [projectScopeKey("proj-b")]: bucket([browserTab("p2", "https://other-project.example")]),
  };

  it("shows global, own project and own chat tabs, in that order", () => {
    const { files, tabScopeById } = collectVisibleTabs(states, target);
    expect(files.map((file) => file.id)).toEqual(["g1", "p1", "c1"]);
    expect(tabScopeById).toEqual({ g1: "global", p1: "project", c1: "chat" });
  });

  it("hides tabs of other chats and other projects", () => {
    const ids = collectVisibleTabs(states, target).files.map((file) => file.id);
    expect(ids).not.toContain("c2");
    expect(ids).not.toContain("p2");
  });

  it("keeps global and project tabs visible after switching to another chat", () => {
    const ids = collectVisibleTabs(states, { projectKey: "proj-a", threadId: "thread-2" }).files.map(
      (file) => file.id,
    );
    expect(ids).toEqual(["g1", "p1", "c2"]);
  });

  it("keeps global tabs visible in a project that has none of its own", () => {
    const ids = collectVisibleTabs(states, { projectKey: "proj-c", threadId: null }).files.map(
      (file) => file.id,
    );
    expect(ids).toEqual(["g1"]);
  });
});

describe("findTabScopeKey", () => {
  it("locates the bucket that holds a tab", () => {
    const states = {
      [GLOBAL_SCOPE_KEY]: bucket([browserTab("g1", "https://global.example")]),
      [chatScopeKey("thread-1")]: bucket([browserTab("c1", "https://chat.example")]),
    };
    expect(findTabScopeKey(states, "c1")).toBe(chatScopeKey("thread-1"));
    expect(findTabScopeKey(states, "g1")).toBe(GLOBAL_SCOPE_KEY);
    expect(findTabScopeKey(states, "missing")).toBeNull();
  });

  it("prefers the visible copy when the same file is open in two chats", () => {
    // Один и тот же файл открыт в двух тредах: закрытие в текущем чате не должно
    // трогать копию соседнего.
    const sameFile: PreviewFile = { id: "/tmp/a.md", name: "a.md", kind: "md", content: "" };
    const states = {
      [chatScopeKey("thread-9")]: bucket([sameFile]),
      [chatScopeKey("thread-1")]: bucket([sameFile]),
    };
    expect(findTabScopeKey(states, "/tmp/a.md", visibleScopeKeys(target))).toBe(
      chatScopeKey("thread-1"),
    );
  });
});

describe("tab persistence", () => {
  it("keeps global and project browser tabs, drops chat tabs", () => {
    const persisted = collectPersistableTabs({
      [GLOBAL_SCOPE_KEY]: bucket([browserTab("g1", "https://global.example")]),
      [projectScopeKey("proj-a")]: bucket([browserTab("p1", "https://project.example")]),
      [chatScopeKey("thread-1")]: bucket([browserTab("c1", "https://chat.example")]),
    });
    expect(Object.keys(persisted).toSorted()).toEqual(
      [GLOBAL_SCOPE_KEY, projectScopeKey("proj-a")].toSorted(),
    );
  });

  it("skips file tabs and empty browser tabs — only URLs survive a reload", () => {
    const persisted = collectPersistableTabs({
      [GLOBAL_SCOPE_KEY]: bucket([
        { id: "f1", name: "report.md", kind: "md", content: "# hi", path: "/tmp/report.md" },
        browserTab("blank", ""),
        browserTab("g1", "https://global.example"),
      ]),
    });
    expect(persisted[GLOBAL_SCOPE_KEY]?.map((tab) => tab.id)).toEqual(["g1"]);
  });

  it("restores tabs as empty browser tabs pointing at their URL", () => {
    const restored = restoreTabs({
      [GLOBAL_SCOPE_KEY]: [{ id: "g1", name: "global.example", url: "https://global.example" }],
    });
    expect(restored[GLOBAL_SCOPE_KEY]).toEqual([
      {
        id: "g1",
        name: "global.example",
        kind: "browser",
        content: "",
        url: "https://global.example",
      },
    ]);
  });
});
