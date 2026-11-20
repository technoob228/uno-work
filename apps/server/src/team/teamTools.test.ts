import { describe, expect, it } from "vitest";

import { TeamCloudError } from "./teamCloud.ts";
import type { TeamMember, TeamProject } from "./teamCloud.logic.ts";
import { projectsHere } from "./teamProjects.ts";
import { pickMember, pickProject, requestRefusal, TEAM_REFUSALS } from "./teamTools.ts";

const projects: ReadonlyArray<TeamProject> = [
  { id: 7, name: "Shop", role: "owner" },
  { id: 8, name: "Blog", role: "editor" },
];

const members: ReadonlyArray<TeamMember> = [
  { userId: 3, email: "misha@example.com", username: "misha", role: "owner" },
  { userId: 9, email: "Andrei@Example.com", username: null, role: "editor" },
];

describe("which project the agent means", () => {
  it("by name or number, else this chat's, else the only one", () => {
    expect(pickProject(projects, "shop", null)).toEqual({ project: projects[0] });
    expect(pickProject(projects, "8", null)).toEqual({ project: projects[1] });
    expect(pickProject(projects, undefined, 8)).toEqual({ project: projects[1] });
    expect(pickProject([projects[0]!], undefined, null)).toEqual({ project: projects[0] });
  });

  it("says what there is when it can't tell", () => {
    expect(pickProject(projects, undefined, null)).toEqual({
      problem: "Say which project: “Shop”, “Blog”.",
    });
    expect(pickProject(projects, "Docs", null)).toMatchObject({
      problem: expect.stringContaining("No team project “Docs”"),
    });
    expect(pickProject([], undefined, null)).toMatchObject({
      problem: expect.stringContaining("isn't in any team project"),
    });
  });
});

describe("which colleague", () => {
  it("by number, email, username or name, any case", () => {
    expect(pickMember(members, "9")?.userId).toBe(9);
    expect(pickMember(members, "andrei@example.com")?.userId).toBe(9);
    expect(pickMember(members, "@Misha")?.userId).toBe(3);
    expect(pickMember(members, "andrei")?.userId).toBe(9);
    expect(pickMember(members, "olga")).toBeNull();
  });
});

describe("the cloud's refusals, as one line", () => {
  const refusal = (status: number, code: string, field = "", kind?: "question") =>
    requestRefusal(new TeamCloudError(status, code, "x", field), "andrei", "Shop", kind);

  it.each([
    [403, "LEVEL_OFF", "LEVEL_OFF:"],
    [409, "TOO_MANY_ROUNDS", "chat_call_person"],
    [409, "TOO_MANY_SESSIONS", "TOO_MANY_SESSIONS:"],
    [429, "REQUEST_RATE_LIMITED", "RATE_LIMIT:"],
    [403, "ASSISTANT_COMPUTER_NO_TEAM_REQUESTS", "assistant's computer"],
    [409, "PERSON_NOT_ENABLED", "isn't on for andrei"],
    [400, "CANNOT_TARGET_SELF", "CANNOT_TARGET_SELF:"],
    [413, "BODY_TOO_LARGE", "BODY_TOO_LARGE:"],
  ])("%i %s", (status, code, words) => {
    expect(refusal(status, code)).toContain(words);
  });

  it("names the field the cloud refused", () => {
    expect(refusal(400, "INVALID_FIELD", "title: too_long")).toContain("title: too_long");
  });

  it("off for this account; questions off on their own", () => {
    expect(refusal(404, "WORK_TEAM_COLLAB_DISABLED")).toBe(TEAM_REFUSALS.off);
    expect(refusal(404, "WORK_TEAM_COLLAB_DISABLED", "", "question")).toContain("Questions");
  });

  it("anything else says what it was", () => {
    expect(requestRefusal(new Error("boom"), "a", "b")).toBe("Couldn't send it: boom");
  });
});

describe("the team projects on this computer", () => {
  it("someone else's by number, one's own by name, only with a folder", () => {
    const here = projectsHere(projects, [
      { projectId: "a", name: "Shop", teamId: null, folder: "/p/shop" },
      { projectId: "b", name: "Blog", teamId: null, folder: "/p/blog" },
      { projectId: "c", name: "Anything", teamId: 8, folder: null },
    ]);
    expect(here).toEqual([
      { teamProjectId: 7, name: "Shop", role: "owner", localProjectId: "a", folder: "/p/shop" },
    ]);
    expect(
      projectsHere(projects, [{ projectId: "d", name: "x", teamId: 8, folder: "/p/b" }]),
    ).toEqual([
      { teamProjectId: 8, name: "Blog", role: "editor", localProjectId: "d", folder: "/p/b" },
    ]);
  });
});
