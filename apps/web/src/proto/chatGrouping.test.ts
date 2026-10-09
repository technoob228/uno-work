import { describe, expect, it } from "vitest";

import {
  chatStatusOf,
  computerPasses,
  effectiveLevels,
  groupChats,
  levelsLabel,
  moveLevel,
  placeShown,
  toggleComputer,
  toggleLevel,
  type ChatGroupNode,
  type GroupLevel,
} from "./chatGrouping";

interface Chat {
  readonly id: string;
  readonly computer: string;
  /** Logical project key: same repository on two computers = one key. */
  readonly project: string;
  readonly status: ReturnType<typeof chatStatusOf>;
}

// Newest first, as the sidebar hands them over.
const CHATS: Chat[] = [
  { id: "a", computer: "mac", project: "repo:site", status: "needs-you" },
  { id: "b", computer: "cloud", project: "repo:site", status: "working" },
  { id: "c", computer: "cloud", project: "none", status: "idle" },
  { id: "d", computer: "mac", project: "mac:notes", status: "your-turn" },
  { id: "e", computer: "cloud", project: "repo:site", status: "done" },
  { id: "f", computer: "mac", project: "none", status: "failed" },
];

const keyOf = {
  status: (chat: Chat) => chat.status,
  computer: (chat: Chat) => chat.computer,
  project: (chat: Chat) => chat.project,
};

function shape(nodes: ReadonlyArray<ChatGroupNode<Chat>> | null): unknown {
  if (nodes === null) return null;
  return nodes.map((node) =>
    node.children === null
      ? [`${node.level}:${node.id}`, node.chats.map((chat) => chat.id)]
      : [`${node.level}:${node.id}`, shape(node.children)],
  );
}

const group = (levels: GroupLevel[], extra?: Partial<Parameters<typeof groupChats<Chat>>[0]>) =>
  groupChats<Chat>({
    chats: CHATS,
    levels,
    keyOf,
    orderOf: { computer: ["cloud", "mac"], project: ["repo:site", "mac:notes", "none"] },
    ...extra,
  });

describe("groupChats", () => {
  it("no level is one list, newest first", () => {
    expect(group([])).toBeNull();
  });

  it("by project: one git project on two computers is one group", () => {
    expect(shape(group(["project"]))).toEqual([
      ["project:repo:site", ["a", "b", "e"]],
      ["project:mac:notes", ["d"]],
      ["project:none", ["c", "f"]],
    ]);
  });

  it("project → computer", () => {
    expect(shape(group(["project", "computer"]))).toEqual([
      [
        "project:repo:site",
        [
          ["computer:cloud", ["b", "e"]],
          ["computer:mac", ["a"]],
        ],
      ],
      ["project:mac:notes", [["computer:mac", ["d"]]]],
      [
        "project:none",
        [
          ["computer:cloud", ["c"]],
          ["computer:mac", ["f"]],
        ],
      ],
    ]);
  });

  it("status → project: statuses in the fixed order (needs you first, done last)", () => {
    expect(shape(group(["status", "project"]))).toEqual([
      ["status:needs-you", [["project:repo:site", ["a"]]]],
      ["status:your-turn", [["project:mac:notes", ["d"]]]],
      ["status:failed", [["project:none", ["f"]]]],
      ["status:working", [["project:repo:site", ["b"]]]],
      ["status:idle", [["project:none", ["c"]]]],
      ["status:done", [["project:repo:site", ["e"]]]],
    ]);
  });

  it("computer → project → status", () => {
    const tree = group(["computer", "project", "status"])!;
    expect(shape(tree)).toEqual([
      [
        "computer:cloud",
        [
          [
            "project:repo:site",
            [
              ["status:working", ["b"]],
              ["status:done", ["e"]],
            ],
          ],
          ["project:none", [["status:idle", ["c"]]]],
        ],
      ],
      [
        "computer:mac",
        [
          ["project:repo:site", [["status:needs-you", ["a"]]]],
          ["project:mac:notes", [["status:your-turn", ["d"]]]],
          ["project:none", [["status:failed", ["f"]]]],
        ],
      ],
    ]);
    // Fold keys are unique and say the whole way down.
    expect(tree[0]!.children![0]!.children![1]!.path).toBe(
      "computer:cloud/project:repo:site/status:done",
    );
    expect(tree[0]!.children![0]!.trail).toEqual({ computer: "cloud", project: "repo:site" });
  });

  it("keys not in the given order come after, by their newest chat", () => {
    expect(
      shape(groupChats<Chat>({ chats: CHATS, levels: ["computer"], keyOf, orderOf: {} })),
    ).toEqual([
      ["computer:mac", ["a", "d", "f"]],
      ["computer:cloud", ["b", "c", "e"]],
    ]);
  });

  it("seeds empty groups (an empty project), but never under a status", () => {
    const seedOf = { project: () => ["repo:empty"] };
    const byProject = group(["project"], { seedOf });
    expect(byProject!.map((node) => node.id)).toContain("repo:empty");
    expect(byProject!.find((node) => node.id === "repo:empty")!.chats).toEqual([]);
    const underStatus = group(["status", "project"], { seedOf });
    for (const node of underStatus!) {
      expect(node.children!.map((child) => child.id)).not.toContain("repo:empty");
    }
  });

  it("a computer filter before grouping leaves the other computer out", () => {
    const picked = ["mac"];
    const tree = groupChats<Chat>({
      chats: CHATS.filter((chat) => computerPasses(picked, chat.computer)),
      levels: ["project"],
      keyOf,
    });
    expect(shape(tree)).toEqual([
      ["project:repo:site", ["a"]],
      ["project:mac:notes", ["d"]],
      ["project:none", ["f"]],
    ]);
  });
});

describe("levels", () => {
  it("drop Computer with fewer than 2 computers in view, and repeats", () => {
    expect(effectiveLevels(["computer", "project"], 1)).toEqual(["project"]);
    expect(effectiveLevels(["computer", "project", "computer"], 2)).toEqual([
      "computer",
      "project",
    ]);
  });

  it("toggle adds last and removes; move swaps neighbours", () => {
    expect(toggleLevel(["project"], "status")).toEqual(["project", "status"]);
    expect(toggleLevel(["project", "status"], "project")).toEqual(["status"]);
    expect(moveLevel(["project", "computer", "status"], "status", -1)).toEqual([
      "project",
      "status",
      "computer",
    ]);
    expect(moveLevel(["project", "computer"], "project", -1)).toEqual(["project", "computer"]);
  });

  it("label reads the order", () => {
    expect(levelsLabel([])).toBe("Newest first");
    expect(levelsLabel(["project", "computer"])).toBe("Project → Computer");
  });

  it("rows say what the groups don't", () => {
    expect(placeShown(["project"], { multi: true })).toEqual({ project: false, computer: true });
    expect(placeShown(["status"], { multi: false })).toEqual({ project: true, computer: false });
    expect(placeShown(["computer", "project"], { multi: true })).toEqual({
      project: false,
      computer: false,
    });
  });
});

describe("computer filter", () => {
  const all = ["cloud", "mac", "pc"];
  it("unticking one of all keeps the rest; ticking all back is all again", () => {
    expect(toggleComputer(null, "mac", all)).toEqual(["cloud", "pc"]);
    expect(toggleComputer(["cloud", "pc"], "mac", all)).toBeNull();
  });
  it("the last one unticked goes back to all, not to nothing", () => {
    expect(toggleComputer(["mac"], "mac", all)).toBeNull();
  });
  it("a computer that's gone is dropped from the pick", () => {
    expect(toggleComputer(["gone", "mac"], "cloud", all)).toEqual(["cloud", "mac"]);
  });
  it("passes", () => {
    expect(computerPasses(null, "x")).toBe(true);
    expect(computerPasses(["mac"], "cloud")).toBe(false);
  });
});

describe("chatStatusOf", () => {
  it("maps the row marks; Done wins", () => {
    expect(chatStatusOf("approval", false)).toBe("needs-you");
    expect(chatStatusOf("input", false)).toBe("needs-you");
    expect(chatStatusOf("your-turn", false)).toBe("your-turn");
    expect(chatStatusOf(null, false)).toBe("idle");
    expect(chatStatusOf("working", true)).toBe("done");
  });
});

describe("saved view", async () => {
  const { DEFAULT_VIEW, parseView } = await import("./protoState");
  it("defaults to all computers together, grouped by project", () => {
    expect(DEFAULT_VIEW).toEqual({ levels: ["project"], computers: null, project: null });
    expect(parseView(null)).toEqual(DEFAULT_VIEW);
  });
  it("keeps known levels once, in order; an empty pick is all", () => {
    expect(parseView({ levels: ["status", "bogus", "project", "status"], computers: [] })).toEqual({
      levels: ["status", "project"],
      computers: null,
      project: null,
    });
    expect(parseView({ levels: [], computers: ["env-1"] }).computers).toEqual(["env-1"]);
  });
});
