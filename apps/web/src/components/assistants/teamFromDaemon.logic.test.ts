import {
  ProjectId,
  type ManagerAssistantSummary,
  type ManagerAssistantTeam,
} from "@t3tools/contracts";
import { DEFAULT_ASSISTANT_MAIL_POLICY } from "@t3tools/shared/assistantMail";
import { presetTokenAccess } from "@t3tools/shared/assistantPreset";
import { describe, expect, it } from "vitest";

import { assistantPageOfUrl } from "../../inbox/assistantPageUrl";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { assistantActivity, buildAssistantTree, FULL_ACCESS } from "./assistantTeam.logic";
import {
  accessOfApps,
  appPermissionsOf,
  channelOf,
  daemonLossLine,
  isConfigured,
  profileFromDaemon,
  projectIdsOf,
  projectsOf,
  setupProgressLine,
} from "./teamFromDaemon.logic";

const ENV = "env-work";

const TEAM: ManagerAssistantTeam = {
  name: null,
  tone: null,
  roles: [],
  character: "",
  skills: [],
  channel: null,
  createdBy: null,
  createdAt: null,
  setup: { state: "not-started", answered: [], skipped: [], threadId: null, updatedAt: null },
  firstTask: null,
  duties: [],
  mail: DEFAULT_ASSISTANT_MAIL_POLICY,
  worksOnWish: null,
  revokedAt: null,
  pausedAt: null,
  activity: [],
};

function summary(input: {
  readonly projectId: string;
  readonly title?: string;
  readonly preset?: "full" | "helper" | "observer";
  readonly projects?: "all" | ReadonlyArray<string>;
  readonly team?: Partial<ManagerAssistantTeam>;
  readonly apps?: { permissions: Record<string, "none" | "read" | "write">; restricted: boolean };
  readonly telegram?: { configured: boolean; botUsername: string | null; shared?: boolean };
}): ManagerAssistantSummary {
  const access = presetTokenAccess(
    input.preset ?? "full",
    (input.projects ?? "all") as never,
    input.projectId,
  );
  return {
    projectId: ProjectId.make(input.projectId),
    title: input.title ?? input.projectId,
    workspaceRoot: `/home/me/UnoWork/Assistants/${input.projectId}`,
    token: {
      tokenId: `tok-${input.projectId}` as never,
      label: input.projectId,
      scopes: access.scopes,
      projectAllowlist: access.projectAllowlist,
      budget: null,
      autoApprove: access.autoApprove,
      createdAt: "2026-10-20T10:00:00.000Z",
      revokedAt: null,
    },
    telegram: {
      configured: input.telegram?.configured ?? false,
      enabled: true,
      allowedChatIds: [],
      botUsername: input.telegram?.botUsername ?? null,
      lastError: null,
      health: null,
      defaultModelSelection: null,
      addressing: {} as never,
      shared: input.telegram?.shared ?? false,
    },
    slack: {
      configured: false,
      enabled: false,
      allowedChannelIds: [],
      botUserId: null,
      botUserName: null,
      lastError: null,
      defaultModelSelection: null,
      addressing: {} as never,
      shared: false,
    },
    skills: [],
    profile: { emoji: "🔭", template: null, createdAt: "2026-10-20T10:00:00.000Z" },
    team: {
      team: { ...TEAM, ...input.team },
      apps: input.apps ?? { permissions: {}, restricted: false },
    },
  };
}

const TITLES = new Map([
  ["p-site", "Site"],
  ["p-shop", "Shop"],
]);

describe("the team from the daemon", () => {
  it("reads who it is, its preset and projects from its token and team record", () => {
    const profile = profileFromDaemon({
      environmentId: ENV,
      projectTitles: TITLES,
      summary: summary({
        projectId: "assistant-scout",
        title: "Scout",
        preset: "helper",
        projects: ["p-site"],
        team: {
          name: "Scout",
          tone: "teal",
          roles: ["Research"],
          character: "Calm",
          createdBy: ProjectId.make("assistant-home"),
          createdAt: "2026-10-21T09:00:00.000Z",
          setup: {
            state: "done",
            answered: ["role"],
            skipped: [],
            threadId: null,
            updatedAt: "2026-10-21T09:30:00.000Z",
          },
          activity: [
            { at: "2026-10-21T09:00:00.000Z", kind: "setup", text: "Role: Research" },
            {
              at: "2026-10-21T09:10:00.000Z",
              kind: "denied",
              text: "Wanted every project",
              by: "auto",
            },
          ],
        },
      }),
    });
    expect(profile).toMatchObject({
      environmentId: ENV,
      projectId: "assistant-scout",
      name: "Scout",
      emoji: "🔭",
      tone: "teal",
      roles: ["Research"],
      character: "Calm",
      preset: "helper",
      // Its own folder is in the token's list, but isn't one of "its projects".
      projects: ["Site"],
      createdBy: `${ENV}:assistant-home`,
      setUpAt: "2026-10-21T09:30:00.000Z",
      revokedAt: null,
      access: FULL_ACCESS,
    });
    // The daemon's "setup" lines read as notes; a refusal stays a refusal.
    expect(profile.activity?.map((entry) => entry.kind)).toEqual(["note", "denied"]);
  });

  it("an assistant from before the team: the folder's title, a stable face, Full", () => {
    const raw = summary({ projectId: "assistant-old", title: "Old helper" });
    const profile = profileFromDaemon({
      environmentId: ENV,
      projectTitles: TITLES,
      summary: { ...raw, team: undefined } as ManagerAssistantSummary,
    });
    expect(profile.name).toBe("Old helper");
    expect(profile.preset).toBe("full");
    expect(profile.projects).toBe("all");
    expect(profile.createdBy).toBeNull();
    expect(profile.setUpAt).toBeNull();
    const again = profileFromDaemon({
      environmentId: ENV,
      projectTitles: TITLES,
      summary: { ...raw, team: undefined } as ManagerAssistantSummary,
    });
    expect(again.tone).toBe(profile.tone);
  });

  it("Uno is Uno: its own face and name", () => {
    const profile = profileFromDaemon({
      environmentId: ENV,
      projectTitles: TITLES,
      summary: summary({ projectId: "assistant-home", title: "Assistant" }),
    });
    expect(profile.name).toBe("Uno");
    expect(profile.emoji).toBeNull();
    expect(profile.tone).toBe("violet");
  });

  it("app levels: unrestricted is full access, a list is per app", () => {
    expect(accessOfApps(null)).toBe(FULL_ACCESS);
    expect(accessOfApps({ restricted: false, permissions: { github: "none" } })).toBe(FULL_ACCESS);
    expect(
      accessOfApps({ restricted: true, permissions: { github: "none", notion: "read" } })
        .connectors,
    ).toEqual({ github: "none", notion: "read" });
    // …and back to what apps.json keeps.
    expect(appPermissionsOf("read")).toEqual({
      gmail: "read",
      "google-drive": "read",
      notion: "read",
      github: "read",
    });
    expect(appPermissionsOf({ github: "none" })).toEqual({ github: "none" });
  });

  it("where you talk: a linked bot wins over what the setup said", () => {
    expect(
      channelOf(
        summary({
          projectId: "assistant-a",
          telegram: { configured: true, botUsername: "scout_bot" },
          team: { channel: "slack" },
        }),
      ),
    ).toEqual({ channel: "own-bot", handle: "@scout_bot" });
    expect(
      channelOf(
        summary({
          projectId: "assistant-a",
          telegram: { configured: true, botUsername: "uno_bot", shared: true },
        }),
      ).channel,
    ).toBe("uno-bot");
    expect(channelOf(summary({ projectId: "assistant-a", team: { channel: "slack" } }))).toEqual({
      channel: "slack",
      handle: null,
    });
  });

  it("projects: titles for the page, ids back for the preset", () => {
    const helper = summary({ projectId: "assistant-a", preset: "helper", projects: ["p-shop"] });
    expect(projectsOf(helper, TITLES)).toEqual(["Shop"]);
    expect(projectIdsOf(["Shop", "Unknown"], TITLES)).toEqual(["p-shop", "Unknown"]);
    expect(projectIdsOf("all", TITLES)).toBe("all");
  });

  it("set up: the setup started, or the person already wrote to it", () => {
    expect(isConfigured(null, false)).toBe(false);
    expect(isConfigured(null, true)).toBe(true);
    expect(isConfigured(TEAM, false)).toBe(false);
    expect(isConfigured({ ...TEAM, setup: { ...TEAM.setup, state: "in-progress" } }, false)).toBe(
      true,
    );
    expect(
      setupProgressLine({
        ...TEAM,
        setup: {
          ...TEAM.setup,
          state: "in-progress",
          answered: ["role", "apps"],
          skipped: ["channel"],
        },
      }),
    ).toBe("Setup: 3 of 7 answered — it goes on where it stopped");
  });

  it("who set up whom: the tree from the daemon's parent links", () => {
    const profiles = [
      ["assistant-home", null],
      ["assistant-scout", "assistant-home"],
      ["assistant-ada", "assistant-scout"],
    ].map(([id, parent]) =>
      profileFromDaemon({
        environmentId: ENV,
        projectTitles: TITLES,
        summary: summary({
          projectId: id!,
          team: parent ? { createdBy: ProjectId.make(parent) } : {},
        }),
      }),
    );
    const tree = buildAssistantTree(
      profiles.map((profile) => ({
        key: `${ENV}:${profile.projectId}`,
        createdBy: profile.createdBy,
        profile,
      })),
    );
    expect(tree).toHaveLength(1);
    expect(tree[0]!.item.profile.projectId).toBe("assistant-home");
    expect(tree[0]!.children[0]!.item.profile.projectId).toBe("assistant-scout");
    expect(tree[0]!.children[0]!.children[0]!.item.profile.projectId).toBe("assistant-ada");
  });

  it("names the daemon's losses", () => {
    expect(daemonLossLine([], (id) => id)).toBeNull();
    expect(
      daemonLossLine(
        [
          { projectId: "assistant-ada", lost: ["project Site", "GitHub"] },
          { projectId: "assistant-milo", lost: ["Helper → Observer"] },
        ],
        (id) => (id === "assistant-ada" ? "Ada" : "Milo"),
      ),
    ).toBe("Ada lost project Site, GitHub; Milo lost Helper → Observer");
  });
});

describe("its dot, from its chats' real state", () => {
  const thread = (patch: Partial<SidebarThreadSummary>) =>
    ({
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      session: null,
      ...patch,
    }) as SidebarThreadSummary;

  it("waiting for you › working › idle", () => {
    const running = thread({ session: { status: "running" } as never });
    const asks = thread({ hasPendingUserInput: true });
    const approval = thread({ hasPendingApprovals: true });
    const done = thread({ session: { status: "ready" } as never });
    const failed = thread({ session: { status: "error" } as never });
    expect(assistantActivity([done, running], resolveSidebarThreadStatus)).toBe("working");
    expect(assistantActivity([running, asks], resolveSidebarThreadStatus)).toBe("waiting");
    expect(assistantActivity([approval], resolveSidebarThreadStatus)).toBe("waiting");
    expect(assistantActivity([done, failed], resolveSidebarThreadStatus)).toBe("idle");
    expect(assistantActivity([], resolveSidebarThreadStatus)).toBe("idle");
  });
});

describe("the Inbox card about an assistant", () => {
  it("opens its page; `this` is the item's own computer", () => {
    expect(assistantPageOfUrl("uno://assistant/this/assistant-scout", ENV)).toEqual({
      environmentId: ENV,
      projectId: "assistant-scout",
    });
    expect(assistantPageOfUrl("uno://assistant/env-other/assistant-ada", ENV)).toEqual({
      environmentId: "env-other",
      projectId: "assistant-ada",
    });
    expect(assistantPageOfUrl("uno://assistant/this/not-an-assistant", ENV)).toBeNull();
    expect(assistantPageOfUrl("https://example.com", ENV)).toBeNull();
  });
});
