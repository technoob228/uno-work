import { describe, expect, it } from "vitest";

import {
  clampGrant,
  grantAppLevel,
  grantBeyond,
  grantWithin,
  setupStepsLeft,
  teamDescendants,
  teamGrant,
  teamProjects,
  type TeamGrant,
} from "./assistantTeam.ts";

const FULL: TeamGrant = { preset: "full", projects: "all", apps: {} };

describe("grantBeyond (child ⊆ parent)", () => {
  it("anything is within Full on every project with every app", () => {
    expect(
      grantBeyond(FULL, { preset: "helper", projects: ["p1"], apps: { gmail: "read" } }),
    ).toEqual([]);
    expect(grantWithin(FULL, FULL)).toBe(true);
  });

  it("a wider preset, projects outside the parent's and higher app levels are named", () => {
    const parent: TeamGrant = {
      preset: "helper",
      projects: ["p1"],
      apps: { gmail: "read", github: "none" },
    };
    const child: TeamGrant = {
      preset: "full",
      projects: ["p1", "p2"],
      apps: { gmail: "write" },
    };
    expect(grantBeyond(parent, child)).toEqual([
      '"Does it itself" is more than "Asks first"',
      "project p2",
      "changes in Gmail & Calendar",
      "GitHub",
    ]);
  });

  it('"every project" is beyond a parent with a list', () => {
    expect(grantBeyond({ ...FULL, projects: ["p1"] }, FULL)).toEqual(["every project"]);
  });

  it("Observer reads only, whatever the app level says", () => {
    const observer: TeamGrant = { preset: "observer", projects: "all", apps: {} };
    expect(grantAppLevel(observer, "notion")).toBe("read");
    expect(grantBeyond(observer, { preset: "observer", projects: "all", apps: {} })).toEqual([]);
    expect(
      grantBeyond(observer, { preset: "helper", projects: "all", apps: { notion: "read" } }),
    ).toContain('"Asks first" is more than "Reads only"');
  });
});

describe("clampGrant (cutting a parent cuts its children)", () => {
  it("narrows preset, projects and apps and says what went", () => {
    const parent: TeamGrant = { preset: "observer", projects: ["p1"], apps: { github: "none" } };
    const child: TeamGrant = { preset: "helper", projects: ["p1", "p2"], apps: {} };
    const { grant, lost } = clampGrant(parent, child);
    expect(grant.preset).toBe("observer");
    expect(grant.projects).toEqual(["p1"]);
    expect(grant.apps.github).toBe("none");
    expect(lost).toEqual(['"Asks first" → "Reads only"', "project p2", "GitHub"]);
  });

  it("leaves a child already within untouched", () => {
    const child: TeamGrant = { preset: "observer", projects: ["p1"], apps: { gmail: "read" } };
    expect(clampGrant(FULL, child)).toEqual({ grant: child, lost: [] });
  });

  it("a child on every project gets the parent's list", () => {
    const { grant, lost } = clampGrant({ ...FULL, projects: ["p1"] }, FULL);
    expect(grant.projects).toEqual(["p1"]);
    expect(lost).toEqual(["projects beyond its creator's"]);
  });
});

describe("teamProjects", () => {
  it("drops assistant workspaces from an allowlist", () => {
    expect(teamProjects(["assistant-scout", "p1", "p1"] as never)).toEqual(["p1"]);
    expect(teamProjects("all")).toBe("all");
    expect(
      teamGrant({ preset: "helper", allowlist: ["assistant-ada", "p2"] as never, apps: {} }),
    ).toEqual({ preset: "helper", projects: ["p2"], apps: {} });
  });
});

describe("teamDescendants", () => {
  it("walks the whole tree, nearest first, and survives loops", () => {
    const items = [
      { id: "uno", createdBy: null },
      { id: "scout", createdBy: "uno" },
      { id: "ada", createdBy: "scout" },
      { id: "milo", createdBy: "uno" },
      { id: "loop", createdBy: "loop" },
    ];
    expect(teamDescendants(items, "uno")).toEqual(["scout", "milo", "ada"]);
    expect(teamDescendants(items, "ada")).toEqual([]);
    expect(teamDescendants(items, "loop")).toEqual([]);
  });
});

describe("setupStepsLeft", () => {
  it("has no routine step any more (28.10: recurring work is an automation)", () => {
    expect(setupStepsLeft({ answered: [], skipped: [] })).not.toContain("routine");
  });

  it("keeps the order and drops answered and skipped steps", () => {
    expect(setupStepsLeft({ answered: ["role", "apps"], skipped: ["channel"] })).toEqual([
      "duties",
      "character",
      "access",
      "mail",
      "computer",
      "first-task",
    ]);
  });
});
