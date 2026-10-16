import { describe, expect, it } from "vitest";

import {
  collectAllTabs,
  foldedGroups,
  groupStripTabs,
  moveToLabel,
  type PanelChatInfo,
} from "./panelTabs.logic";
import { chatScopeKey, GLOBAL_SCOPE_KEY, projectScopeKey } from "./previewTabScopes";
import type { PreviewFile } from "./PreviewPaneContext";
import { collectVisibleTabs, DEFAULT_PREVIEW_BUCKET_STATE } from "./previewPanelState";
import { collectPersistableTabs, restoreTabs } from "./previewTabPersistence";

function file(name: string, path = `/p/${name}`): PreviewFile {
  return { id: path, name, kind: "md", content: "", path };
}

const pult: PreviewFile = {
  id: "app:pult",
  name: "Pult",
  kind: "app",
  content: "",
  url: "https://pult",
};
const readme = file("README.md");
const hero = file("hero.md");
const pricing = file("pricing.md");
const research = file("research.docx");

describe("groupStripTabs", () => {
  it("groups left to right: Everywhere → Project → This chat", () => {
    const scopes = {
      [pult.id]: "global",
      [readme.id]: "project",
      [pricing.id]: "project",
      [hero.id]: "chat",
    } as const;
    expect(groupStripTabs([pult, readme, pricing, hero], scopes)).toEqual([
      { scope: "global", files: [pult] },
      { scope: "project", files: [readme, pricing] },
      { scope: "chat", files: [hero] },
    ]);
  });

  it("an empty group is not drawn; a tab of unknown level is the chat's", () => {
    expect(groupStripTabs([hero], {})).toEqual([{ scope: "chat", files: [hero] }]);
  });
});

describe("foldedGroups", () => {
  const groups = [
    { scope: "global", count: 1, active: false },
    { scope: "project", count: 2, active: false },
    { scope: "chat", count: 3, active: true },
  ] as const;

  it("nothing folds while every tab gets 72 px", () => {
    // 3 groups × 30 + 6 × 72 + (0 + 1 + 2) × 2 = 528
    expect(foldedGroups({ available: 528, groups, withIcons: true })).toEqual([]);
  });

  it("the chat's group folds first, so Everywhere and Project stay as they were", () => {
    expect(foldedGroups({ available: 500, groups, withIcons: true })).toEqual(["chat"]);
  });

  it("then Project, then Everywhere", () => {
    expect(foldedGroups({ available: 360, groups, withIcons: true })).toEqual(["chat", "project"]);
    expect(foldedGroups({ available: 100, groups, withIcons: true })).toEqual([
      "chat",
      "project",
      "global",
    ]);
  });

  it("groups without icons take less room", () => {
    expect(foldedGroups({ available: 470, groups, withIcons: false })).toEqual([]);
  });
});

describe("collectAllTabs", () => {
  const chats: Record<string, PanelChatInfo> = {
    a: { title: "Landing copy", projectKey: "landing", environmentId: "mac" },
    b: { title: "Hero", projectKey: "landing", environmentId: "mac" },
    c: { title: "Pricing", projectKey: "landing", environmentId: "cloud" },
    x: { title: "Bench", projectKey: "model-lab", environmentId: "cloud" },
  };
  const states = {
    [GLOBAL_SCOPE_KEY]: { files: [pult] },
    [projectScopeKey("landing")]: { files: [readme] },
    [chatScopeKey("a")]: { files: [hero] },
    [chatScopeKey("b")]: { files: [file("hero-variants.png"), { ...hero }] },
    [chatScopeKey("c")]: { files: [research, file("README.md")] },
    [chatScopeKey("x")]: { files: [file("bench.md")] },
    [chatScopeKey("gone")]: { files: [file("old.md")] },
  };
  const chatInfo = (id: string) => chats[id] ?? null;
  const target = { projectKey: "landing", threadId: "a" };

  it("lists this chat, the project's pins and 'everywhere'", () => {
    const sections = collectAllTabs({ states, target, chatInfo });
    expect(sections.thisChat).toEqual([hero]);
    expect(sections.project).toEqual([readme]);
    expect(sections.everywhere).toEqual([pult]);
  });

  it("'In other chats' — documents of other chats of this project, not already open here", () => {
    const { otherChats } = collectAllTabs({ states, target, chatInfo });
    expect(otherChats.map((entry) => [entry.file.name, entry.chat.title])).toEqual([
      ["hero-variants.png", "Hero"],
      ["research.docx", "Pricing"],
    ]);
  });

  it("outside a chat: only 'everywhere' is here, every chat counts as other", () => {
    const sections = collectAllTabs({
      states,
      target: { projectKey: "landing", threadId: null },
      chatInfo,
    });
    expect(sections.thisChat).toEqual([]);
    expect(sections.project).toEqual([]);
    expect(sections.otherChats.map((entry) => entry.file.name)).toContain("bench.md");
  });

  it("search matches the name and the chat's title", () => {
    const byName = collectAllTabs({ states, target, chatInfo, query: "DOCX" });
    expect(byName.otherChats.map((entry) => entry.file.name)).toEqual(["research.docx"]);
    expect(byName.thisChat).toEqual([]);
    const byChat = collectAllTabs({ states, target, chatInfo, query: "hero" });
    expect(byChat.thisChat).toEqual([hero]);
    expect(byChat.otherChats.map((entry) => entry.file.name)).toEqual(["hero-variants.png"]);
  });

  it("the tasks tab and empty new tabs of another chat are not listed", () => {
    const sections = collectAllTabs({
      states: {
        [chatScopeKey("b")]: {
          files: [
            { id: "tasks:b", name: "Tasks", kind: "tasks", content: "" },
            { id: "browser-1", name: "New tab", kind: "browser", content: "", url: "" },
          ],
        },
      },
      target,
      chatInfo,
    });
    expect(sections.otherChats).toEqual([]);
  });
});

describe("moveToLabel", () => {
  it("names the project", () => {
    expect(moveToLabel("project", "landing")).toBe("Project · landing");
    expect(moveToLabel("chat", "landing")).toBe("This chat");
    expect(moveToLabel("global", "landing")).toBe("Everywhere");
  });
});

describe("tabs saved by 0.0.137 and earlier", () => {
  // `uno_preview_tabs_v1` as older versions wrote it: browser tabs of the
  // long levels only. The groups read it as is — no new format, no migration.
  const saved = {
    [GLOBAL_SCOPE_KEY]: [{ id: "browser-3", name: "Pult", url: "https://pult.example/" }],
    [projectScopeKey("landing")]: [
      { id: "browser-7", name: "Stage", url: "https://stage.example/" },
    ],
  };

  it("come back as the Everywhere and Project groups", () => {
    const restored = restoreTabs(saved);
    const states = Object.fromEntries(
      Object.entries(restored).map(([key, files]) => [
        key,
        { ...DEFAULT_PREVIEW_BUCKET_STATE, files },
      ]),
    );
    const { files, tabScopeById } = collectVisibleTabs(states, {
      projectKey: "landing",
      threadId: "t1",
    });
    expect(
      groupStripTabs(files, tabScopeById).map((group) => [
        group.scope,
        group.files.map((tab) => tab.id),
      ]),
    ).toEqual([
      ["global", ["browser-3"]],
      ["project", ["browser-7"]],
    ]);
  });

  it("the agent mark is not written into the saved format", () => {
    const saving = collectPersistableTabs({
      [GLOBAL_SCOPE_KEY]: {
        files: [
          {
            id: "browser-3",
            name: "Pult",
            kind: "browser",
            content: "",
            url: "https://pult.example/",
            openedBy: "agent",
          },
        ],
      },
    });
    expect(saving).toEqual({ [GLOBAL_SCOPE_KEY]: [saved[GLOBAL_SCOPE_KEY]![0]] });
  });
});
