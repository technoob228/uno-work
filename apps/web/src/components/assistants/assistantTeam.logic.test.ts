import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  type AssistantProfile,
  FULL_ACCESS,
  NEW_TEAMMATE_ACCESS,
  activityFeed,
  assistantActivity,
  brainLine,
  cascadeRights,
  clampToParent,
  lossLine,
  needsOwnComputer,
  ownComputerName,
  pickedLine,
  suggestName,
  togglePicked,
  toggleRole,
  assistantProjectIdFor,
  buildAssistantTree,
  chatsOfAssistant,
  defaultDraft,
  descendantKeys,
  isTeamConversation,
  previewChats,
  rightsBeyondParent,
  telegramStartLink,
  uniqueName,
} from "./assistantTeam.logic";

const thread = (
  id: string,
  projectId: string,
  extra: Partial<{
    environmentId: string;
    archivedAt: string | null;
    assistantRole: "chat" | "spawned" | null;
    spawnedByThreadId: string | null;
    at: number;
  }> = {},
) => ({
  id,
  environmentId: extra.environmentId ?? "env-1",
  projectId,
  archivedAt: extra.archivedAt ?? null,
  assistantRole: extra.assistantRole ?? null,
  spawnedByThreadId: extra.spawnedByThreadId ?? null,
  at: extra.at ?? 0,
});

describe("defaultDraft", () => {
  it("comes filled in: Uno's bot, every project, this computer, full access, Uno AI", () => {
    const draft = defaultDraft({ thisComputer: "env-1", existing: [] });
    expect(draft).toMatchObject({
      channel: "uno-bot",
      projects: "all",
      computers: ["env-1"],
      preset: "full",
      brain: "uno",
    });
    expect(draft.emoji).not.toBeNull();
  });

  it("sets Uno up as Uno, with its own face", () => {
    const draft = defaultDraft({ thisComputer: null, existing: [], forUno: true });
    expect(draft.name).toBe("Uno");
    expect(draft.emoji).toBeNull();
    expect(draft.computers).toEqual([]);
  });
});

describe("names and folders", () => {
  it("never repeats a name on the team", () => {
    expect(uniqueName("Scout", ["Uno", "Builder"])).toBe("Scout");
    expect(uniqueName("scout", ["Uno", "Scout"])).toBe("scout 2");
    expect(uniqueName("  ", [])).toBe("Assistant");
  });

  it("makes an assistant-* folder id", () => {
    expect(assistantProjectIdFor("Scout 2")).toBe("assistant-scout-2");
    expect(assistantProjectIdFor("Ада")).toBe("assistant-new");
  });
});

describe("rightsBeyondParent", () => {
  const uno = { preset: "full", projects: "all", computers: ["mac", "work"] } as const;
  it("is empty when the child stays within its parent", () => {
    expect(
      rightsBeyondParent(uno, { preset: "observer", projects: ["landing"], computers: ["work"] }),
    ).toEqual([]);
  });

  it("names what goes beyond: preset, projects, computers", () => {
    const helper = { preset: "helper", projects: ["fishcode"], computers: ["work"] } as const;
    expect(
      rightsBeyondParent(helper, {
        preset: "full",
        projects: ["fishcode", "landing"],
        computers: ["mac"],
      }),
    ).toEqual(["Full access is more than Helper", "landing", "mac"]);
    expect(
      rightsBeyondParent(helper, { preset: "helper", projects: "all", computers: [] }),
    ).toEqual(["every project"]);
  });
});

describe("who set up whom", () => {
  const team = [
    { key: "uno", createdBy: null },
    { key: "scout", createdBy: "uno" },
    { key: "intern", createdBy: "scout" },
    { key: "builder", createdBy: null },
    { key: "orphan", createdBy: "gone" },
  ];

  it("builds the tree, a child of a missing parent at the root", () => {
    const tree = buildAssistantTree(team);
    expect(tree.map((node) => node.item.key)).toEqual(["uno", "builder", "orphan"]);
    expect(tree[0]!.children[0]!.item.key).toBe("scout");
    expect(tree[0]!.children[0]!.children[0]!.item.key).toBe("intern");
  });

  it("revoking one takes everything it set up, all the way down", () => {
    expect(descendantKeys(team, "uno")).toEqual(["scout", "intern"]);
    expect(descendantKeys(team, "builder")).toEqual([]);
  });

  it("survives a loop", () => {
    const loop = [
      { key: "a", createdBy: "b" },
      { key: "b", createdBy: "a" },
    ];
    expect(descendantKeys(loop, "a")).toEqual(["b"]);
    expect(buildAssistantTree(loop)).toEqual([]);
  });
});

const at = (item: { at: number }) => item.at;

describe("chatsOfAssistant", () => {
  const threads = [
    thread("main", ASSISTANT_PROJECT_ID, { assistantRole: "chat", at: 5 }),
    thread("older", ASSISTANT_PROJECT_ID, { at: 1 }),
    thread("newer", ASSISTANT_PROJECT_ID, { at: 9 }),
    thread("archived", ASSISTANT_PROJECT_ID, { archivedAt: "x", at: 10 }),
    thread("work", "p-fishcode", { spawnedByThreadId: "main", at: 7 }),
    thread("marked", "p-landing", { assistantRole: "spawned", at: 3 }),
    thread("scout-talk", "assistant-scout", { at: 8 }),
    thread("other-computer", ASSISTANT_PROJECT_ID, { environmentId: "env-2", at: 12 }),
  ];

  it("lists Uno's conversations newest first, and the chats it started", () => {
    const chats = chatsOfAssistant(
      threads,
      { environmentId: "env-1", projectId: ASSISTANT_PROJECT_ID },
      at,
    );
    expect(chats.conversations.map((item) => item.id)).toEqual(["newer", "main", "older"]);
    expect(chats.work.map((item) => item.id)).toEqual(["work", "marked"]);
  });

  it("keeps another assistant's chats to itself", () => {
    const chats = chatsOfAssistant(
      threads,
      { environmentId: "env-1", projectId: "assistant-scout" },
      at,
    );
    expect(chats.conversations.map((item) => item.id)).toEqual(["scout-talk"]);
    expect(chats.work).toEqual([]);
  });

  it("does not count work an agent started in the assistant's folder as a conversation", () => {
    expect(isTeamConversation({ projectId: "assistant-scout", spawnedByThreadId: "x" })).toBe(
      false,
    );
    expect(isTeamConversation({ projectId: "assistant-scout", assistantRole: "spawned" })).toBe(
      false,
    );
    expect(isTeamConversation({ projectId: "p-landing", assistantRole: "chat" })).toBe(true);
  });
});

describe("assistantActivity", () => {
  it("waiting beats working beats free", () => {
    expect(assistantActivity(["ready", "working", "input"] as const, (s) => s)).toBe("waiting");
    expect(assistantActivity(["ready", "working"] as const, (s) => s)).toBe("working");
    expect(assistantActivity(["ready", "failed"] as const, (s) => s)).toBe("idle");
    expect(assistantActivity([], (s: "ready") => s)).toBe("idle");
  });
});

describe("previewChats", () => {
  const chats = ["a", "b", "c", "d", "e"];
  it("shows three, then Show N more", () => {
    expect(previewChats(chats, { showAll: false, isOpen: () => false })).toEqual({
      visible: ["a", "b", "c"],
      hiddenCount: 2,
    });
  });

  it("keeps the open chat in view", () => {
    expect(previewChats(chats, { showAll: false, isOpen: (chat) => chat === "e" })).toEqual({
      visible: ["a", "b", "c", "e"],
      hiddenCount: 1,
    });
  });

  it("shows all on request", () => {
    expect(previewChats(chats, { showAll: true, isOpen: () => false }).hiddenCount).toBe(0);
  });
});

describe("telegramStartLink", () => {
  it("is the one-tap deep link", () => {
    expect(telegramStartLink("@uno_team_bot", "ab c")).toBe(
      "https://t.me/uno_team_bot?start=ab%20c",
    );
  });
});

const profile = (name: string, extra: Partial<AssistantProfile> = {}): AssistantProfile => ({
  environmentId: "env-1",
  projectId: `assistant-${name.toLowerCase()}`,
  name,
  emoji: "🙂",
  tone: "violet",
  roles: [],
  character: "",
  skills: [],
  preset: "full",
  brain: "uno",
  channel: "uno-bot",
  channelHandle: null,
  projects: "all",
  computers: ["env-1"],
  createdBy: null,
  createdAt: "2026-10-01T00:00:00Z",
  setUpAt: null,
  revokedAt: null,
  ...extra,
});

describe("names and roles", () => {
  it("suggests a name nobody has yet", () => {
    expect(suggestName(["Ada"])).toBe("Scout");
  });
  it("picking a role turns on its first skills; unpicking drops them", () => {
    const on = toggleRole({ roles: [], skills: [] }, "Developer");
    expect(on.roles).toEqual(["Developer"]);
    expect(on.skills.length).toBeGreaterThan(0);
    const off = toggleRole(on, "Developer");
    expect(off.roles).toEqual([]);
  });
});

describe("picked lists", () => {
  const all = ["a", "b", "c"];
  it("unticking one of all keeps the rest", () => {
    expect(togglePicked("all", "b", all)).toEqual(["a", "c"]);
  });
  it("says it plainly", () => {
    const names = all.map((id) => ({ id, name: id.toUpperCase() }));
    expect(pickedLine("all", names, { all: "every", none: "none" })).toBe("every (3)");
    expect(pickedLine([], names, { all: "every", none: "none" })).toBe("none");
  });
  it("a new teammate starts with no passwords; Uno with all", () => {
    expect(NEW_TEAMMATE_ACCESS.secrets).toEqual([]);
    expect(NEW_TEAMMATE_ACCESS.logins).toEqual([]);
    expect(FULL_ACCESS.secrets).toBe("all");
  });
});

describe("cutting rights down the tree (16.10)", () => {
  const uno = profile("Uno", { projectId: ASSISTANT_PROJECT_ID });
  const unoKey = `env-1:${ASSISTANT_PROJECT_ID}`;
  const scout = profile("Scout", {
    preset: "helper",
    createdBy: unoKey,
    projects: ["landing", "uno-project"],
    access: { ...NEW_TEAMMATE_ACCESS, connectors: ["google-drive", "github"] },
  });
  const helper = profile("Echo", {
    preset: "observer",
    createdBy: "env-1:assistant-scout",
    access: { ...NEW_TEAMMATE_ACCESS, connectors: ["github"] },
  });
  const team = { [unoKey]: uno, "env-1:assistant-scout": scout, "env-1:assistant-echo": helper };

  it("clamps a child to its parent and names what it lost", () => {
    const { child, lost } = clampToParent(
      { ...uno, preset: "observer", projects: ["landing"] },
      scout,
    );
    expect(child.preset).toBe("observer");
    expect(child.projects).toEqual(["landing"]);
    expect(lost).toContain("uno-project");
  });

  it("goes all the way down and lists who lost what", () => {
    const { profiles, losses } = cascadeRights(team, unoKey, {
      access: { ...FULL_ACCESS, connectors: ["google-drive"] },
    });
    expect(losses.map((loss) => loss.name)).toEqual(["Scout", "Echo"]);
    expect(profiles["env-1:assistant-echo"]!.access!.connectors).toEqual([]);
    expect(lossLine(losses)).toBe("Scout will lose: GitHub · Echo will lose: GitHub");
  });

  it("losing nothing says nothing", () => {
    expect(cascadeRights(team, unoKey, { preset: "full" }).losses).toEqual([]);
  });
});

describe("its own computer (16.10)", () => {
  it("limited rights need one; full access and Uno don't", () => {
    expect(needsOwnComputer({ preset: "helper" }, false)).toBe(true);
    expect(needsOwnComputer({ preset: "helper", ownComputer: "scout-box" }, false)).toBe(false);
    expect(needsOwnComputer({ preset: "full" }, false)).toBe(false);
    expect(needsOwnComputer({ preset: "observer" }, true)).toBe(false);
  });
  it("is named after it", () => {
    expect(ownComputerName("Scout")).toBe("scout-box");
  });
});

describe("whose AI it spends", () => {
  it("says the plan and who shares it", () => {
    const team = [
      profile("Uno"),
      profile("Scout", { brain: "chatgpt" }),
      profile("Ada", { brain: "chatgpt" }),
    ];
    expect(brainLine(team[1]!, team)).toBe("Uses your ChatGPT plan's limits · shared with Ada");
    expect(brainLine(team[0]!, team)).toBe("Uno AI · from your plan's AI hours");
  });
});

describe("activityFeed", () => {
  it("mixes its own events with chats, newest first, money flagged", () => {
    const feed = activityFeed(
      [{ at: "2026-10-15T10:00:00Z", kind: "money", text: "Paid" }],
      [{ title: "Chat", at: "2026-10-15T11:00:00Z" }],
    );
    expect(feed.map((entry) => entry.text)).toEqual(["Chat", "Paid"]);
    expect(feed.map((entry) => entry.important)).toEqual([false, true]);
  });
});
