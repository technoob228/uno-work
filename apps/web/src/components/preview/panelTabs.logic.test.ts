import { describe, expect, it } from "vitest";

import {
  dropBeforeId,
  foldedGroups,
  groupLabelWidth,
  GROUP_LETTER,
  groupsForDrag,
  groupStripTabs,
  moveToLabel,
  scopeHint,
  tabsShownInGroup,
} from "./panelTabs.logic";
import { GLOBAL_SCOPE_KEY, projectScopeKey } from "./previewTabScopes";
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

describe("groupStripTabs", () => {
  it("groups left to right: This chat → Project → Everywhere (wider further right)", () => {
    const scopes = {
      [pult.id]: "global",
      [readme.id]: "project",
      [pricing.id]: "project",
      [hero.id]: "chat",
    } as const;
    expect(groupStripTabs([pult, readme, pricing, hero], scopes)).toEqual([
      { scope: "chat", files: [hero] },
      { scope: "project", files: [readme, pricing] },
      { scope: "global", files: [pult] },
    ]);
  });

  it("an empty group is not drawn; a tab of unknown level is the chat's", () => {
    expect(groupStripTabs([hero], {})).toEqual([{ scope: "chat", files: [hero] }]);
  });
});

describe("groupsForDrag", () => {
  it("while dragging, all three groups show — a missing one as an empty slot to drop into", () => {
    const groups = groupStripTabs([pult, hero], { [pult.id]: "global", [hero.id]: "chat" });
    expect(groupsForDrag(groups, true)).toEqual([
      { scope: "chat", files: [hero] },
      { scope: "project", files: [] },
      { scope: "global", files: [pult] },
    ]);
  });

  it("only Everywhere has tabs: This chat and Project come as slots", () => {
    const groups = groupStripTabs([pult], { [pult.id]: "global" });
    expect(groupsForDrag(groups, true).map((group) => group.scope)).toEqual([
      "chat",
      "project",
      "global",
    ]);
  });

  it("not dragging: the groups as they are", () => {
    const groups = groupStripTabs([hero], {});
    expect(groupsForDrag(groups, false)).toBe(groups);
  });
});

describe("dropBeforeId", () => {
  const group = [readme, hero, pricing];
  it("left half of a tab: before it", () => {
    expect(dropBeforeId(group, hero.id, true)).toBe(hero.id);
  });
  it("right half: before the next tab, or the group's end after the last one", () => {
    expect(dropBeforeId(group, hero.id, false)).toBe(pricing.id);
    expect(dropBeforeId(group, pricing.id, false)).toBeNull();
  });
  it("a tab not in the group: the end", () => {
    expect(dropBeforeId(group, pult.id, true)).toBeNull();
  });
});

describe("scopeHint", () => {
  it("says where the tab stays pinned", () => {
    expect(scopeHint("chat", "uno")).toBe("Pinned while you're in this chat");
    expect(scopeHint("project", "uno-site")).toBe("Pinned while you're in uno-site");
    expect(scopeHint("project", null)).toBe("Pinned while you're in this project");
    expect(scopeHint("project", "  ")).toBe("Pinned while you're in this project");
    expect(scopeHint("global", null)).toBe("Always pinned — in every chat and screen");
  });
});

describe("tabsShownInGroup", () => {
  it("a collapsed group keeps only the open tab, if it is there", () => {
    expect(tabsShownInGroup([readme, pricing], false, hero.id)).toEqual([readme, pricing]);
    expect(tabsShownInGroup([readme, pricing], true, pricing.id)).toEqual([pricing]);
    expect(tabsShownInGroup([readme, pricing], true, hero.id)).toEqual([]);
  });
});

describe("foldedGroups", () => {
  const groups = [
    { scope: "chat", count: 3, active: true, labelWidth: 22 },
    { scope: "project", count: 2, active: false, labelWidth: 22 },
    { scope: "global", count: 1, active: false, labelWidth: 22 },
  ] as const;

  it("nothing folds while every tab gets 72 px", () => {
    // 3 groups × (10 + 22) + 6 × 72 + 6 × 2 = 540
    expect(foldedGroups({ available: 540, groups })).toEqual([]);
  });

  it("the chat's group folds first, so Everywhere and Project stay as they were", () => {
    expect(foldedGroups({ available: 520, groups })).toEqual(["chat"]);
  });

  it("then Project, then Everywhere", () => {
    expect(foldedGroups({ available: 380, groups })).toEqual(["chat", "project"]);
    expect(foldedGroups({ available: 100, groups })).toEqual(["chat", "project", "global"]);
  });

  it("a collapsed group takes only its label (and the open tab)", () => {
    const collapsed = [
      { scope: "chat", count: 3, active: true, labelWidth: 22 },
      {
        scope: "project",
        count: 0,
        active: false,
        labelWidth: groupLabelWidth("project", true, 2),
      },
      { scope: "global", count: 1, active: false, labelWidth: 22 },
    ] as const;
    expect(foldedGroups({ available: 410, groups: collapsed })).toEqual([]);
  });
});

describe("groupLabelWidth", () => {
  it("an icon is narrower than a name; a collapsed group adds its count", () => {
    expect(groupLabelWidth("global", true)).toBeLessThan(groupLabelWidth("global", false));
    expect(groupLabelWidth("project", false, 3)).toBeGreaterThan(groupLabelWidth("project", false));
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
      ["project", ["browser-7"]],
      ["global", ["browser-3"]],
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

describe("GROUP_LETTER", () => {
  it("gives each group its own letter: Chat, Project, Everywhere", () => {
    expect(GROUP_LETTER).toEqual({ chat: "C", project: "P", global: "E" });
  });
});
