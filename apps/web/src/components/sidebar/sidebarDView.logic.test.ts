import { describe, expect, it } from "vitest";

import {
  canGroupByComputer,
  chatRowShowsComputer,
  filterChatsByProject,
  groupChatsByComputer,
  projectRowComputers,
  resolveSidebarDView,
  sidebarDViewTitle,
} from "./sidebarDView.logic";

describe("resolveSidebarDView", () => {
  it("keeps the stored choice", () => {
    expect(resolveSidebarDView("list", true)).toBe("list");
    expect(resolveSidebarDView("projects", true)).toBe("projects");
  });
  it("falls back to the old Inbox switch", () => {
    expect(resolveSidebarDView(null, true)).toBe("inbox");
    expect(resolveSidebarDView(null, false)).toBe("projects");
  });
});

describe("sidebarDViewTitle", () => {
  it("says what is shown", () => {
    expect(sidebarDViewTitle("projects", "fishcode")).toBe("Projects");
    expect(sidebarDViewTitle("list", null)).toBe("All projects");
    expect(sidebarDViewTitle("list", "fishcode")).toBe("fishcode");
    expect(sidebarDViewTitle("inbox", null)).toBe("Inbox");
  });
});

describe("canGroupByComputer", () => {
  it("needs several computers and a view by place", () => {
    expect(canGroupByComputer("projects", true)).toBe(true);
    expect(canGroupByComputer("list", true)).toBe(true);
    expect(canGroupByComputer("inbox", true)).toBe(false);
    expect(canGroupByComputer("projects", false)).toBe(false);
  });
});

describe("projectRowComputers", () => {
  it("names nothing with one computer", () => {
    expect(
      projectRowComputers({ computers: ["work"], thisComputer: "mac", multiComputer: false }),
    ).toEqual([]);
  });
  it("names nothing when the project lives here", () => {
    expect(
      projectRowComputers({
        computers: ["mac", "product"],
        thisComputer: "mac",
        multiComputer: true,
      }),
    ).toEqual([]);
  });
  it("names the computers of a project that lives elsewhere", () => {
    expect(
      projectRowComputers({
        computers: ["product", "product"],
        thisComputer: "mac",
        multiComputer: true,
      }),
    ).toEqual(["product"]);
  });
});

describe("chatRowShowsComputer", () => {
  const base = {
    thisComputer: "mac",
    multiComputer: true,
    underComputerHeader: false,
  } as const;
  it("never with one computer or under a computer header", () => {
    expect(
      chatRowShowsComputer({
        ...base,
        multiComputer: false,
        chatComputer: "work",
        projectComputers: null,
      }),
    ).toBe(false);
    expect(
      chatRowShowsComputer({
        ...base,
        underComputerHeader: true,
        chatComputer: "work",
        projectComputers: null,
      }),
    ).toBe(false);
  });
  it("never for a chat on this computer", () => {
    expect(chatRowShowsComputer({ ...base, chatComputer: "mac", projectComputers: null })).toBe(
      false,
    );
  });
  it("in one list: every chat from another computer", () => {
    expect(chatRowShowsComputer({ ...base, chatComputer: "work", projectComputers: null })).toBe(
      true,
    );
  });
  it("in a project: only when the project spans several computers", () => {
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
  });
});

describe("groupChatsByComputer", () => {
  const computers = [
    { environmentId: null, key: "box-2611", label: "spark-lab", status: "sleeping" as const },
    { environmentId: "work", key: "work", label: "uno-work", status: "online" as const },
    { environmentId: "mac", key: "mac", label: "MacBook", status: "online" as const },
    { environmentId: "product", key: "product", label: "uno-product", status: "online" as const },
  ];
  it("this computer first, asleep last, every computer keeps its header", () => {
    const sections = groupChatsByComputer({
      chats: [
        { id: 1, env: "work" },
        { id: 2, env: "mac" },
        { id: 3, env: "work" },
      ],
      computerOf: (chat) => chat.env,
      computers,
      thisComputer: "mac",
    });
    expect(sections.map((section) => section.computer.label)).toEqual([
      "MacBook",
      "uno-work",
      "uno-product",
      "spark-lab",
    ]);
    expect(sections[0]!.isThis).toBe(true);
    expect(sections[1]!.chats.map((chat) => chat.id)).toEqual([1, 3]);
    expect(sections[2]!.chats).toEqual([]);
    expect(sections[3]!.dimmed).toBe(true);
  });
});

describe("filterChatsByProject", () => {
  const chats = [
    { id: 1, group: "fishcode" },
    { id: 2, group: "home-folder" },
  ];
  it("keeps one project's chats", () => {
    expect(
      filterChatsByProject({
        chats,
        filterKey: "home-folder",
        knownKeys: new Set(["fishcode", "home-folder"]),
        groupKeyOf: (chat) => chat.group,
      }).map((chat) => chat.id),
    ).toEqual([2]);
  });
  it("shows all for no filter or a project that is gone", () => {
    expect(
      filterChatsByProject({
        chats,
        filterKey: "landing",
        knownKeys: new Set(["fishcode"]),
        groupKeyOf: (chat) => chat.group,
      }),
    ).toHaveLength(2);
  });
});
