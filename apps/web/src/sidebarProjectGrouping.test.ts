import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
import type { Project } from "./types";

const primaryEnvId = EnvironmentId.make("env-primary");
const remoteEnvId = EnvironmentId.make("env-remote");
const otherRemoteEnvId = EnvironmentId.make("env-other-remote");

const SHARED_REPO_CANONICAL_KEY = "github.com/example/shared-repo";

const GROUPING_SETTINGS = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(
  overrides: Partial<Project> & Pick<Project, "id" | "environmentId" | "name">,
): Project {
  return {
    cwd: `/tmp/${overrides.name}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function makeSharedRepoProject(
  input: Pick<Project, "id" | "environmentId" | "name"> & { cwd?: string },
): Project {
  return makeProject({
    ...input,
    cwd: input.cwd ?? `/tmp/${input.name}`,
    repositoryIdentity: {
      canonicalKey: SHARED_REPO_CANONICAL_KEY,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://${SHARED_REPO_CANONICAL_KEY}.git`,
      },
      rootPath: input.cwd ?? `/tmp/${input.name}`,
      displayName: "example/shared-repo",
      name: "shared-repo",
      owner: "example",
    },
  });
}

const LABELS: Record<string, string> = {
  [primaryEnvId]: "Laptop",
  [remoteEnvId]: "prod-1",
  [otherRemoteEnvId]: "prod-2",
};

const resolveLabel = (environmentId: EnvironmentId): string | null => LABELS[environmentId] ?? null;

describe("buildSidebarProjectSnapshots", () => {
  it("reports 'unknown' presence when the primary environment has not resolved", () => {
    // The desktop being reopened after being closed is exactly this window.
    // Reporting "local-only" here would have the sidebar claim that work
    // running on three different servers is local.
    const projects = [
      makeSharedRepoProject({ id: ProjectId.make("p1"), environmentId: primaryEnvId, name: "a" }),
      makeSharedRepoProject({ id: ProjectId.make("p2"), environmentId: remoteEnvId, name: "b" }),
      makeSharedRepoProject({
        id: ProjectId.make("p3"),
        environmentId: otherRemoteEnvId,
        name: "c",
      }),
    ];

    const [snapshot] = buildSidebarProjectSnapshots({
      projects,
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: null,
      resolveEnvironmentLabel: resolveLabel,
    });

    expect(snapshot?.environmentPresence).toBe("unknown");
    expect(snapshot?.groupedProjectCount).toBe(3);
    // With no primary to subtract, every environment in the group is listed,
    // in the deterministic member order (sorted by environmentId).
    expect(snapshot?.remoteEnvironmentLabels).toEqual(["prod-2", "Laptop", "prod-1"]);
  });

  it("classifies mixed, remote-only and local-only groups against the primary", () => {
    const mixed = buildSidebarProjectSnapshots({
      projects: [
        makeSharedRepoProject({ id: ProjectId.make("p1"), environmentId: primaryEnvId, name: "a" }),
        makeSharedRepoProject({ id: ProjectId.make("p2"), environmentId: remoteEnvId, name: "b" }),
      ],
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: primaryEnvId,
      resolveEnvironmentLabel: resolveLabel,
    });
    expect(mixed[0]?.environmentPresence).toBe("mixed");
    expect(mixed[0]?.remoteEnvironmentLabels).toEqual(["prod-1"]);

    const remoteOnly = buildSidebarProjectSnapshots({
      projects: [
        makeSharedRepoProject({ id: ProjectId.make("p2"), environmentId: remoteEnvId, name: "b" }),
      ],
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: primaryEnvId,
      resolveEnvironmentLabel: resolveLabel,
    });
    expect(remoteOnly[0]?.environmentPresence).toBe("remote-only");

    const localOnly = buildSidebarProjectSnapshots({
      projects: [
        makeSharedRepoProject({ id: ProjectId.make("p1"), environmentId: primaryEnvId, name: "a" }),
      ],
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: primaryEnvId,
      resolveEnvironmentLabel: resolveLabel,
    });
    expect(localOnly[0]?.environmentPresence).toBe("local-only");
    expect(localOnly[0]?.remoteEnvironmentLabels).toEqual([]);
  });

  it("falls back to the environment id when a label has not loaded", () => {
    // Dropping the member instead (the previous `.flatMap` behaviour) makes the
    // badge understate how far the group spreads, which is worse than an ugly id.
    const snapshots = buildSidebarProjectSnapshots({
      projects: [
        makeSharedRepoProject({ id: ProjectId.make("p1"), environmentId: primaryEnvId, name: "a" }),
        makeSharedRepoProject({ id: ProjectId.make("p2"), environmentId: remoteEnvId, name: "b" }),
      ],
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: primaryEnvId,
      resolveEnvironmentLabel: () => null,
    });

    expect(snapshots[0]?.remoteEnvironmentLabels).toEqual([remoteEnvId]);
  });

  it("dedupes repeated environment labels", () => {
    const snapshots = buildSidebarProjectSnapshots({
      projects: [
        makeSharedRepoProject({ id: ProjectId.make("p1"), environmentId: primaryEnvId, name: "a" }),
        makeSharedRepoProject({
          id: ProjectId.make("p2"),
          environmentId: remoteEnvId,
          name: "b",
          cwd: "/srv/one",
        }),
        makeSharedRepoProject({
          id: ProjectId.make("p3"),
          environmentId: remoteEnvId,
          name: "c",
          cwd: "/srv/two",
        }),
      ],
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: primaryEnvId,
      resolveEnvironmentLabel: resolveLabel,
    });

    expect(snapshots[0]?.groupedProjectCount).toBe(3);
    expect(snapshots[0]?.remoteEnvironmentLabels).toEqual(["prod-1"]);
  });

  it("picks the same representative regardless of input order", () => {
    const a = makeSharedRepoProject({
      id: ProjectId.make("p-remote"),
      environmentId: remoteEnvId,
      name: "remote",
    });
    const b = makeSharedRepoProject({
      id: ProjectId.make("p-other"),
      environmentId: otherRemoteEnvId,
      name: "other",
    });

    const forward = buildSidebarProjectSnapshots({
      projects: [a, b],
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: null,
      resolveEnvironmentLabel: resolveLabel,
    });
    const reversed = buildSidebarProjectSnapshots({
      projects: [b, a],
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: null,
      resolveEnvironmentLabel: resolveLabel,
    });

    expect(forward[0]?.id).toBe(reversed[0]?.id);
    expect(forward[0]?.memberProjects.map((member) => member.id)).toEqual(
      reversed[0]?.memberProjects.map((member) => member.id),
    );
  });

  it("prefers the primary environment's project as representative", () => {
    const snapshots = buildSidebarProjectSnapshots({
      projects: [
        makeSharedRepoProject({
          id: ProjectId.make("p-remote"),
          environmentId: remoteEnvId,
          name: "remote",
        }),
        makeSharedRepoProject({
          id: ProjectId.make("p-local"),
          environmentId: primaryEnvId,
          name: "local",
        }),
      ],
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: primaryEnvId,
      resolveEnvironmentLabel: resolveLabel,
    });

    expect(snapshots[0]?.environmentId).toBe(primaryEnvId);
  });

  it("keeps a project in its own group while its repository identity is missing", () => {
    // Identity resolution is transiently null before migration 037 backfills it.
    // The un-identified project must not collapse into or dissolve the real group.
    const identified = makeSharedRepoProject({
      id: ProjectId.make("p-identified"),
      environmentId: primaryEnvId,
      name: "identified",
    });
    const pending = makeProject({
      id: ProjectId.make("p-pending"),
      environmentId: remoteEnvId,
      name: "pending",
    });

    const snapshots = buildSidebarProjectSnapshots({
      projects: [identified, pending],
      settings: GROUPING_SETTINGS,
      primaryEnvironmentId: primaryEnvId,
      resolveEnvironmentLabel: resolveLabel,
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots.find((s) => s.id === identified.id)?.groupedProjectCount).toBe(1);
    expect(snapshots.find((s) => s.id === pending.id)?.groupedProjectCount).toBe(1);
  });
});
