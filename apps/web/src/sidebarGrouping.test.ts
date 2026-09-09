import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildSidebarMachineGroups,
  partitionThreadsByEnvironment,
  sortMachineEnvironmentIds,
} from "./sidebarGrouping";
import type { Project, SidebarThreadSummary } from "./types";

const laptop = EnvironmentId.make("env-laptop");
const prod1 = EnvironmentId.make("env-prod-1");
const prod2 = EnvironmentId.make("env-prod-2");

const SHARED_REPO = "github.com/example/shared-repo";

const LABELS: Record<string, string> = {
  [laptop]: "Laptop",
  [prod1]: "prod-1",
  [prod2]: "prod-2",
};
const resolveEnvironmentLabel = (environmentId: EnvironmentId): string | null =>
  LABELS[environmentId] ?? null;

const GROUPING_SETTINGS = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(
  input: Pick<Project, "id" | "environmentId" | "name"> & { sharedRepo?: boolean },
): Project {
  return {
    cwd: `/tmp/${input.name}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    id: input.id,
    environmentId: input.environmentId,
    name: input.name,
    ...(input.sharedRepo === true
      ? {
          repositoryIdentity: {
            canonicalKey: SHARED_REPO,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://${SHARED_REPO}.git`,
            },
            rootPath: `/tmp/${input.name}`,
            displayName: "example/shared-repo",
            name: "shared-repo",
            owner: "example",
          },
        }
      : {}),
  };
}

function makeThread(input: {
  id: string;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  updatedAt?: string;
}): SidebarThreadSummary {
  return {
    id: ThreadId.make(input.id),
    environmentId: input.environmentId,
    projectId: input.projectId,
    title: input.id,
    interactionMode: "default",
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    updatedAt: input.updatedAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const laptopProjectId = ProjectId.make("p-laptop");
const prod1ProjectId = ProjectId.make("p-prod-1");
const prod1OtherProjectId = ProjectId.make("p-prod-1-other");

const PROJECTS: Project[] = [
  makeProject({ id: laptopProjectId, environmentId: laptop, name: "app", sharedRepo: true }),
  makeProject({ id: prod1ProjectId, environmentId: prod1, name: "app", sharedRepo: true }),
  makeProject({ id: prod1OtherProjectId, environmentId: prod1, name: "backend" }),
];

const THREADS: SidebarThreadSummary[] = [
  makeThread({
    id: "t-laptop",
    environmentId: laptop,
    projectId: laptopProjectId,
    updatedAt: "2026-01-03T00:00:00.000Z",
  }),
  makeThread({
    id: "t-prod-1",
    environmentId: prod1,
    projectId: prod1ProjectId,
    updatedAt: "2026-01-05T00:00:00.000Z",
  }),
  makeThread({
    id: "t-prod-1-backend",
    environmentId: prod1,
    projectId: prod1OtherProjectId,
    updatedAt: "2026-01-02T00:00:00.000Z",
  }),
];

function build(overrides?: {
  environmentIds?: readonly EnvironmentId[];
  sortOrder?: "activity" | "name" | "manual";
  manualOrder?: readonly string[];
}) {
  return buildSidebarMachineGroups({
    environmentIds: overrides?.environmentIds ?? [laptop, prod1, prod2],
    projects: PROJECTS,
    threads: THREADS,
    settings: GROUPING_SETTINGS,
    primaryEnvironmentId: laptop,
    resolveEnvironmentLabel,
    sortOrder: overrides?.sortOrder ?? "activity",
    manualOrder: overrides?.manualOrder ?? [],
  });
}

describe("sortMachineEnvironmentIds", () => {
  const base = {
    environmentIds: [laptop, prod1, prod2],
    resolveLabel: resolveEnvironmentLabel,
    resolveLastActivityAt: (environmentId: EnvironmentId): string | null =>
      environmentId === prod1
        ? "2026-01-05T00:00:00.000Z"
        : environmentId === laptop
          ? "2026-01-03T00:00:00.000Z"
          : null,
  };

  it("puts the most recently active machine first and idle ones last", () => {
    expect(sortMachineEnvironmentIds({ ...base, sortOrder: "activity", manualOrder: [] })).toEqual([
      prod1,
      laptop,
      prod2,
    ]);
  });

  it("sorts by label when asked", () => {
    expect(sortMachineEnvironmentIds({ ...base, sortOrder: "name", manualOrder: [] })).toEqual([
      laptop,
      prod1,
      prod2,
    ]);
  });

  it("honours a manual order and appends unknown machines deterministically", () => {
    expect(
      sortMachineEnvironmentIds({ ...base, sortOrder: "manual", manualOrder: [prod2, prod1] }),
    ).toEqual([prod2, prod1, laptop]);
  });

  it("is a total order, so equal keys cannot swap between renders", () => {
    const allIdle = {
      ...base,
      resolveLastActivityAt: () => null,
      sortOrder: "activity" as const,
      manualOrder: [],
    };
    const forwards = sortMachineEnvironmentIds(allIdle);
    const backwards = sortMachineEnvironmentIds({
      ...allIdle,
      environmentIds: [prod2, prod1, laptop],
    });
    expect(forwards).toEqual(backwards);
  });
});

describe("buildSidebarMachineGroups", () => {
  it("groups projects and chats under their machine", () => {
    const groups = build({ sortOrder: "name" });

    expect(groups.map((group) => group.environmentId)).toEqual([laptop, prod1, prod2]);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["t-laptop"]);
    expect(groups[1]?.threads.map((thread) => thread.id)).toEqual(["t-prod-1", "t-prod-1-backend"]);
    // Inside a machine every group has a single member, so the row is named
    // after the folder rather than the repository slug — which is the more
    // useful label once the machine is already known from the heading.
    expect(groups[1]?.projects.map((project) => project.displayName)).toEqual(["app", "backend"]);
  });

  it("keeps a connected machine with nothing on it, so it stays reachable", () => {
    const groups = build({ sortOrder: "name" });
    const empty = groups.find((group) => group.environmentId === prod2);

    expect(empty).toBeDefined();
    expect(empty?.projects).toEqual([]);
    expect(empty?.threads).toEqual([]);
    expect(empty?.lastActivityAt).toBeNull();
  });

  it("never drops a machine that appears only in the data", () => {
    const groups = buildSidebarMachineGroups({
      environmentIds: [laptop],
      projects: PROJECTS,
      threads: THREADS,
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: laptop,
      resolveEnvironmentLabel,
      sortOrder: "name",
      manualOrder: [],
    });

    expect(groups.map((group) => group.environmentId)).toContain(prod1);
    expect(groups.flatMap((group) => group.threads.map((thread) => thread.id)).sort()).toEqual([
      "t-laptop",
      "t-prod-1",
      "t-prod-1-backend",
    ]);
  });

  it("reports the latest activity per machine for activity sorting", () => {
    const groups = build();

    expect(groups.map((group) => group.environmentId)).toEqual([prod1, laptop, prod2]);
    expect(groups[0]?.lastActivityAt).toBe("2026-01-05T00:00:00.000Z");
  });

  it("splits a shared repository into one project per machine, not one merged row", () => {
    const groups = build({ sortOrder: "name" });

    // The same repo lives on the laptop and on prod-1; grouping by machine must
    // show it under each, otherwise the machine row would lie about what is on it.
    expect(groups[0]?.projects).toHaveLength(1);
    expect(groups[0]?.projects[0]?.memberProjectRefs).toHaveLength(1);
    expect(groups[1]?.projects[0]?.memberProjectRefs).toHaveLength(1);
  });
});

describe("partitionThreadsByEnvironment", () => {
  it("orders sub-groups by the machine order so headings match across projects", () => {
    const partitions = partitionThreadsByEnvironment({
      threads: THREADS,
      environmentOrder: [prod1, laptop],
    });

    expect(partitions.map((partition) => partition.environmentId)).toEqual([prod1, laptop]);
    expect(partitions[0]?.threads.map((thread) => thread.id)).toEqual([
      "t-prod-1",
      "t-prod-1-backend",
    ]);
  });

  it("appends environments missing from the order instead of dropping their chats", () => {
    const partitions = partitionThreadsByEnvironment({
      threads: THREADS,
      environmentOrder: [laptop],
    });

    expect(partitions.map((partition) => partition.environmentId)).toEqual([laptop, prod1]);
  });

  it("returns nothing for no chats", () => {
    expect(partitionThreadsByEnvironment({ threads: [], environmentOrder: [laptop] })).toEqual([]);
  });
});
