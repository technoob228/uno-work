import type { ManagerAssistantTeam } from "@t3tools/contracts";
import { DEFAULT_ASSISTANT_MAIL_POLICY } from "@t3tools/shared/assistantMail";
import { describe, expect, it } from "vitest";

import {
  matchProjects,
  moveAssistantToComputer,
  type MoveAssistantDeps,
  teamUpdateOf,
} from "./moveAssistant";

const TEAM: ManagerAssistantTeam = {
  name: "Scout",
  tone: "teal",
  roles: ["Dev"],
  character: "Calm and brief",
  skills: [],
  channel: "telegram",
  createdBy: null,
  createdAt: null,
  setup: { state: "done", answered: [], skipped: [], threadId: null, updatedAt: null },
  firstTask: null,
  duties: ["Watch CI on fishcode"],
  mail: { ...DEFAULT_ASSISTANT_MAIL_POLICY, recipients: "owner", dailyLimit: 10 },
  worksOnWish: "cloud",
  revokedAt: null,
  pausedAt: null,
  activity: [],
};

function fakes(options: { readonly failWrite?: boolean } = {}) {
  const calls: string[] = [];
  const deps: MoveAssistantDeps = {
    readFile: async (env, _project, name) => {
      calls.push(`read ${env} ${name}`);
      return name === "ROUTING.md" ? "" : `# ${name}\nsomething`;
    },
    getApps: async () => ({ permissions: { gmail: "read" }, restricted: true }),
    listProjects: async () => [
      { id: "p-fish-cloud", title: "fishcode" },
      { id: "assistant-home", title: "fishcode" },
    ],
    createAssistant: async (env, input) => {
      calls.push(
        `create ${env} ${input.name} ${input.access.preset} ${JSON.stringify(input.access.projects)}`,
      );
      return { projectId: "assistant-scout" };
    },
    writeFile: async (env, project, name) => {
      if (options.failWrite) throw new Error("disk full");
      calls.push(`write ${env} ${project} ${name}`);
    },
    putApps: async (env, _project, permissions) => {
      calls.push(`apps ${env} ${JSON.stringify(permissions)}`);
    },
    updateTeam: async (env, _project, input) => {
      calls.push(`team ${env} ${JSON.stringify(input)}`);
    },
    deleteAssistant: async (env, project) => {
      calls.push(`delete ${env} ${project}`);
    },
  };
  return { deps, calls };
}

const from = {
  environmentId: "env-mac",
  projectId: "assistant-scout",
  name: "Scout",
  emoji: "🔭",
  preset: "helper" as const,
  projects: ["fishcode", "landing"],
  team: TEAM,
};

describe("moving an assistant to another computer", () => {
  it("matches its projects there by name and says which aren't there yet", () => {
    expect(matchProjects("all", [])).toEqual({ projects: "all", missing: [] });
    expect(
      matchProjects(
        ["Fishcode", "landing"],
        [
          { id: "assistant-x", title: "landing" },
          { id: "p1", title: "fishcode" },
        ],
      ),
    ).toEqual({ projects: ["p1"], missing: ["landing"] });
  });

  it("makes it there with its memory, apps and team record, then deletes the one here", async () => {
    const { deps, calls } = fakes();
    const result = await moveAssistantToComputer({ from, toEnvironmentId: "env-cloud" }, deps);
    expect(result).toEqual({ projectId: "assistant-scout", missingProjects: ["landing"] });
    expect(calls).toContain('create env-cloud Scout helper ["p-fish-cloud"]');
    expect(calls.filter((call) => call.startsWith("write"))).toEqual([
      "write env-cloud assistant-scout SOUL.md",
      "write env-cloud assistant-scout USER.md",
      "write env-cloud assistant-scout NOTES.md",
    ]);
    expect(calls).toContain('apps env-cloud {"gmail":"read"}');
    const team = calls.find((call) => call.startsWith("team"))!;
    expect(team).toContain('"duties":["Watch CI on fishcode"]');
    expect(team).toContain('"recipients":"owner"');
    expect(team).toContain('"setup":"done"');
    expect(calls.at(-1)).toBe("delete env-mac assistant-scout");
  });

  it("removes nothing here when the copy didn't get there whole", async () => {
    const { deps, calls } = fakes({ failWrite: true });
    await expect(
      moveAssistantToComputer({ from, toEnvironmentId: "env-cloud" }, deps),
    ).rejects.toThrow(/Nothing was removed here/);
    expect(calls.some((call) => call.startsWith("delete"))).toBe(false);
  });

  it("refuses a move to the computer it is on", async () => {
    const { deps } = fakes();
    await expect(
      moveAssistantToComputer({ from, toEnvironmentId: "env-mac" }, deps),
    ).rejects.toThrow(/already works/);
  });

  it("an assistant from before the team moves as set up", () => {
    expect(teamUpdateOf(null)).toEqual({ setup: "done" });
  });
});
