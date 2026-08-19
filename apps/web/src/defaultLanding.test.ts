import { describe, expect, it } from "vitest";

import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { resolveDefaultLandingTarget, type LandingThreadCandidate } from "./defaultLanding";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;

function thread(
  id: string,
  overrides: Partial<LandingThreadCandidate> = {},
): LandingThreadCandidate {
  return {
    id: id as ThreadId,
    environmentId: ENV_A,
    projectId: "project-1" as ProjectId,
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("resolveDefaultLandingTarget", () => {
  it("resumes the most recently worked-on thread", () => {
    const target = resolveDefaultLandingTarget({
      threads: [
        thread("old", { latestUserMessageAt: "2026-08-01T10:00:00.000Z" }),
        thread("recent", { latestUserMessageAt: "2026-08-05T10:00:00.000Z" }),
        thread("middle", { latestUserMessageAt: "2026-08-03T10:00:00.000Z" }),
      ],
      projects: [],
    });

    expect(target).toEqual({ kind: "thread", environmentId: ENV_A, threadId: "recent" });
  });

  it("falls back to updates and creation when nobody has spoken yet", () => {
    const target = resolveDefaultLandingTarget({
      threads: [
        thread("created-early", { createdAt: "2026-08-01T00:00:00.000Z" }),
        thread("updated-late", {
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-09T00:00:00.000Z",
        }),
      ],
      projects: [],
    });

    expect(target).toMatchObject({ kind: "thread", threadId: "updated-late" });
  });

  it("ignores archived threads", () => {
    const target = resolveDefaultLandingTarget({
      threads: [
        thread("archived", {
          archivedAt: "2026-08-09T00:00:00.000Z",
          latestUserMessageAt: "2026-08-09T00:00:00.000Z",
        }),
        thread("live", { latestUserMessageAt: "2026-08-02T00:00:00.000Z" }),
      ],
      projects: [],
    });

    expect(target).toMatchObject({ kind: "thread", threadId: "live" });
  });

  it("prefers the active environment over a newer thread elsewhere", () => {
    const target = resolveDefaultLandingTarget({
      threads: [
        thread("remote-newer", {
          environmentId: ENV_B,
          latestUserMessageAt: "2026-08-09T00:00:00.000Z",
        }),
        thread("local-older", { latestUserMessageAt: "2026-08-02T00:00:00.000Z" }),
      ],
      projects: [],
      activeEnvironmentId: ENV_A,
    });

    expect(target).toMatchObject({ kind: "thread", threadId: "local-older" });
  });

  it("still resumes elsewhere when the active environment has nothing", () => {
    const target = resolveDefaultLandingTarget({
      threads: [thread("remote", { environmentId: ENV_B })],
      projects: [],
      activeEnvironmentId: ENV_A,
    });

    expect(target).toMatchObject({ kind: "thread", threadId: "remote" });
  });

  it("opens a composer for the preferred project when there is nothing to resume", () => {
    const target = resolveDefaultLandingTarget({
      threads: [],
      projects: [
        { id: "project-a" as ProjectId, environmentId: ENV_A, orderKey: "env-a:/home/a" },
        { id: "project-b" as ProjectId, environmentId: ENV_A, orderKey: "env-a:/home/b" },
      ],
      projectOrder: ["env-a:/home/b", "env-a:/home/a"],
    });

    expect(target).toEqual({ kind: "draft", environmentId: ENV_A, projectId: "project-b" });
  });

  it("falls back to the first project when the order is unknown", () => {
    const target = resolveDefaultLandingTarget({
      threads: [],
      projects: [{ id: "only" as ProjectId, environmentId: ENV_A }],
    });

    expect(target).toMatchObject({ kind: "draft", projectId: "only" });
  });

  it("reports empty when there is no project either", () => {
    expect(resolveDefaultLandingTarget({ threads: [], projects: [] })).toEqual({ kind: "empty" });
  });
});
