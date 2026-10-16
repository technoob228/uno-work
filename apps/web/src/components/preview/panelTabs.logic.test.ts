import { describe, expect, it } from "vitest";

import {
  collectAllTabs,
  fitStripTabs,
  pinLabel,
  scopeChoiceLabel,
  scopeForDrop,
  splitStripTabs,
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

describe("splitStripTabs", () => {
  const scopes = { [pult.id]: "global", [readme.id]: "project", [hero.id]: "chat" } as const;
  const files = [pult, readme, hero];

  it("A: everything kept longer than the chat is an icon pin, the chat's tabs are named", () => {
    expect(splitStripTabs(files, scopes, "pins")).toEqual({
      pinned: [pult, readme],
      named: [hero],
    });
  });

  it("B: project tabs are ordinary named tabs, only 'everywhere' is pinned", () => {
    expect(splitStripTabs(files, scopes, "project")).toEqual({
      pinned: [pult],
      named: [readme, hero],
    });
  });

  it("a tab without a known level counts as the chat's", () => {
    expect(splitStripTabs([hero], {}, "pins").named).toEqual([hero]);
  });
});

describe("scopeForDrop", () => {
  it("A: a chat tab dropped on the pins is pinned to the project", () => {
    expect(scopeForDrop("pinned", "chat", "pins")).toBe("project");
  });
  it("A: a pin dropped among the chat's tabs goes back to the chat", () => {
    expect(scopeForDrop("named", "project", "pins")).toBe("chat");
    expect(scopeForDrop("named", "global", "pins")).toBe("chat");
  });
  it("A: dropping where it already is does nothing; 'everywhere' stays everywhere", () => {
    expect(scopeForDrop("named", "chat", "pins")).toBeNull();
    expect(scopeForDrop("pinned", "global", "pins")).toBeNull();
  });
  it("B: the pin zone means 'everywhere', leaving it means the project", () => {
    expect(scopeForDrop("pinned", "project", "project")).toBe("global");
    expect(scopeForDrop("named", "global", "project")).toBe("project");
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

describe("scopeChoiceLabel", () => {
  it("names the project", () => {
    expect(scopeChoiceLabel("project", "landing", "pins")).toBe("Pin to project landing");
    expect(scopeChoiceLabel("chat", "landing", "pins")).toBe("Keep in this chat");
    expect(scopeChoiceLabel("global", "landing", "pins")).toBe("Show in every chat");
  });
});

describe("fitStripTabs", () => {
  it("keeps names while every tab gets at least 72 px", () => {
    expect(fitStripTabs(300, 4)).toBe("names"); // 4×72 + 3×4 = 300
    expect(fitStripTabs(299, 4)).toBe("icons");
  });
  it("a single tab always keeps its name", () => {
    expect(fitStripTabs(40, 1)).toBe("names");
  });
});

describe("pinLabel", () => {
  it("drops the extension of files, keeps app and page names", () => {
    expect(pinLabel({ name: "README.md", kind: "md" })).toBe("README");
    expect(pinLabel({ name: ".env", kind: "text" })).toBe(".env");
    expect(pinLabel({ name: "Pult", kind: "app" })).toBe("Pult");
  });
});

describe("tabs saved by 0.0.137 and earlier", () => {
  // `uno_preview_tabs_v1` as older versions wrote it: browser tabs of the
  // long levels only. The pins read it as is — no new format, no migration.
  const saved = {
    [GLOBAL_SCOPE_KEY]: [{ id: "browser-3", name: "Pult", url: "https://pult.example/" }],
    [projectScopeKey("landing")]: [
      { id: "browser-7", name: "Stage", url: "https://stage.example/" },
    ],
  };

  it("come back as pins: every chat first, then the project", () => {
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
    const strip = splitStripTabs(files, tabScopeById, "pins");
    expect(strip.pinned.map((tab) => tab.id)).toEqual(["browser-3", "browser-7"]);
    expect(strip.named).toEqual([]);
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
