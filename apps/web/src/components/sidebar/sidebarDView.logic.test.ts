import { describe, expect, it } from "vitest";

import {
  chatRowShowsComputer,
  effectiveLevels,
  headerPresetOf,
  groupSidebarChats,
  levelsForPreset,
  levelsLabel,
  livePicks,
  moveLevel,
  orderComputers,
  placeShown,
  presetOf,
  projectRowComputers,
  resolveGroupLevels,
  sidebarDTitle,
  toggleFilter,
  toggleLevel,
} from "./sidebarDView.logic";

describe("group levels", () => {
  it("falls back to the old Inbox switch until chosen", () => {
    expect(resolveGroupLevels(null, true)).toEqual(["status"]);
    expect(resolveGroupLevels(null, false)).toEqual(["project"]);
    expect(resolveGroupLevels([], true)).toEqual([]);
  });
  it("drops Computer with one computer in view, and repeats", () => {
    expect(effectiveLevels(["computer", "project"], 1)).toEqual(["project"]);
    expect(effectiveLevels(["computer", "project", "computer"], 3)).toEqual([
      "computer",
      "project",
    ]);
  });
  it("toggles a level to the end, moves it, names the order", () => {
    expect(toggleLevel(["project"], "computer")).toEqual(["project", "computer"]);
    expect(toggleLevel(["project", "computer"], "project")).toEqual(["computer"]);
    expect(moveLevel(["project", "computer"], "computer", -1)).toEqual(["computer", "project"]);
    expect(moveLevel(["project", "computer"], "project", -1)).toEqual(["project", "computer"]);
    expect(levelsLabel(["computer", "project"])).toBe("Computer → Project");
    expect(levelsLabel([])).toBe("One list, newest first");
  });
  it("maps the Settings presets both ways, keeping Computer", () => {
    expect(presetOf([])).toBe("list");
    expect(presetOf(["computer", "project"])).toBe("projects");
    expect(presetOf(["status"])).toBe("inbox");
    expect(presetOf(["status", "project"])).toBeNull();
    expect(levelsForPreset("inbox", true)).toEqual(["computer", "status"]);
    expect(levelsForPreset("list", false)).toEqual([]);
  });
});

describe("filters", () => {
  const all = ["landing", "fishcode", "home-folder"];
  it("the first pick narrows to it; none or all again is all", () => {
    expect(toggleFilter(null, "landing", all)).toEqual(["landing"]);
    expect(toggleFilter(["landing"], "fishcode", all)).toEqual(["landing", "fishcode"]);
    expect(toggleFilter(["landing"], "landing", all)).toBeNull();
    expect(toggleFilter(["landing", "fishcode"], "home-folder", all)).toBeNull();
  });
  it("forgets picks that are gone", () => {
    expect(livePicks(["gone"], all)).toBeNull();
    expect(livePicks(["gone", "landing"], all)).toEqual(["landing"]);
  });
});

describe("title, presets, place", () => {
  it("the title says which chats are shown", () => {
    expect(sidebarDTitle({ projectNames: null, computerNames: null })).toBe("All chats");
    expect(sidebarDTitle({ projectNames: ["landing"], computerNames: null })).toBe(
      "Chats · landing",
    );
    expect(sidebarDTitle({ projectNames: ["a", "b"], computerNames: ["MacBook"] })).toBe(
      "Chats · 2 projects · MacBook",
    );
  });
  it("knows the four ready ways, anything else is custom", () => {
    expect(headerPresetOf([])).toBe("list");
    expect(headerPresetOf(["computer", "project"])).toBe("computer");
    expect(headerPresetOf(["project", "computer"])).toBeNull();
  });
  it("a row names its project unless grouped by project, its computer unless by computer", () => {
    expect(placeShown([], true)).toEqual({ project: true, computer: true });
    expect(placeShown(["status"], false)).toEqual({ project: true, computer: false });
    expect(placeShown(["computer", "project"], true)).toEqual({
      project: false,
      computer: false,
    });
  });
});

describe("computers", () => {
  it("a project row names computers only when it lives elsewhere", () => {
    expect(
      projectRowComputers({ computers: ["work"], thisComputer: "mac", multiComputer: false }),
    ).toEqual([]);
    expect(
      projectRowComputers({
        computers: ["mac", "product"],
        thisComputer: "mac",
        multiComputer: true,
      }),
    ).toEqual([]);
    expect(
      projectRowComputers({
        computers: ["product", "product"],
        thisComputer: "mac",
        multiComputer: true,
      }),
    ).toEqual(["product"]);
  });
  it("a chat row carries its computer when it is not said above", () => {
    const base = { thisComputer: "mac", multiComputer: true, underComputerHeader: false } as const;
    expect(chatRowShowsComputer({ ...base, chatComputer: "mac", projectComputers: null })).toBe(
      false,
    );
    expect(chatRowShowsComputer({ ...base, chatComputer: "work", projectComputers: null })).toBe(
      true,
    );
    expect(
      chatRowShowsComputer({ ...base, chatComputer: "work", projectComputers: ["work"] }),
    ).toBe(false);
    expect(
      chatRowShowsComputer({
        ...base,
        chatComputer: "product",
        projectComputers: ["mac", "product"],
      }),
    ).toBe(true);
    expect(
      chatRowShowsComputer({
        ...base,
        underComputerHeader: true,
        chatComputer: "work",
        projectComputers: null,
      }),
    ).toBe(false);
  });
  it("orders this computer first and the sleeping ones last", () => {
    const order = orderComputers(
      [
        { environmentId: null, key: "box", label: "spark-lab", status: "sleeping" },
        { environmentId: "work", key: "work", label: "uno-work", status: "online" },
        { environmentId: "mac", key: "mac", label: "MacBook", status: "online" },
      ],
      "mac",
    );
    expect(order.map((computer) => computer.label)).toEqual(["MacBook", "uno-work", "spark-lab"]);
  });
});

describe("groupSidebarChats", () => {
  const chats = [
    { id: 1, env: "mac", project: "landing", status: "working" },
    { id: 2, env: "product", project: "landing", status: "needs-you" },
    { id: 3, env: "mac", project: "fishcode", status: "idle" },
  ];
  const keyOf = {
    computer: (chat: (typeof chats)[number]) => chat.env,
    project: (chat: (typeof chats)[number]) => chat.project,
    status: (chat: (typeof chats)[number]) => chat.status,
  };
  it("no level is one list", () => {
    expect(groupSidebarChats({ chats, levels: [], keyOf })).toBeNull();
  });
  it("groups computer → project, seeding the ones without chats", () => {
    const tree = groupSidebarChats({
      chats,
      levels: ["computer", "project"],
      keyOf,
      orderOf: { computer: ["mac", "product", "spark"] },
      seedOf: { computer: () => ["spark"] },
    })!;
    expect(tree.map((node) => node.id)).toEqual(["mac", "product", "spark"]);
    expect(tree[0]!.children!.map((node) => node.id)).toEqual(["landing", "fishcode"]);
    expect(tree[0]!.children![0]!.path).toBe("computer:mac/project:landing");
    expect(tree[2]!.chats).toEqual([]);
  });
  it("orders statuses as given and seeds nothing under a status", () => {
    const tree = groupSidebarChats({
      chats,
      levels: ["status", "project"],
      keyOf,
      orderOf: { status: ["needs-you", "working", "idle"] },
      seedOf: { project: () => ["empty"] },
    })!;
    expect(tree.map((node) => node.id)).toEqual(["needs-you", "working", "idle"]);
    expect(tree[0]!.children!.map((node) => node.id)).toEqual(["landing"]);
  });
});
