import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  deriveProjectGroupLabel,
  type ProjectGroupingSettings,
} from "./logicalProject";
import type { Project } from "./types";

/**
 * Where a logical project's members live, relative to the *primary*
 * environment — the machine the person is sitting at.
 *
 * `"unknown"` is not a cosmetic fourth case. Until the primary environment
 * resolves (startup, reconnect, the desktop being reopened after it was
 * closed) there is no anchor to measure "local" against, and reporting
 * `"local-only"` there would have the UI assert that remote work is local.
 */
export type EnvironmentPresence = "local-only" | "remote-only" | "mixed" | "unknown";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  /**
   * Environments other than the primary one this group spans, in display form.
   *
   * When `environmentPresence` is `"unknown"` there is no primary to subtract,
   * so this lists every environment the group spans. Members whose label has
   * not loaded yet fall back to their `environmentId` rather than being
   * dropped: a badge that says "also on 3f2a…" is honest, a badge that silently
   * omits an environment is not.
   */
  remoteEnvironmentLabels: readonly string[];
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const project of input.projects) {
    mapping.set(
      derivePhysicalProjectKey(project),
      deriveLogicalProjectKeyFromSettings(project, input.settings),
    );
  }
  return mapping;
}

/**
 * Total order over group members, so the row a group renders (name, cwd,
 * favicon, target of a click) does not depend on the order projects happened to
 * arrive in. Without this the representative is `members[0]` in arrival order
 * and a group's displayed metadata can hop between environments on reconnect.
 */
function compareMembers(left: SidebarProjectGroupMember, right: SidebarProjectGroupMember): number {
  if (left.environmentId !== right.environmentId) {
    return left.environmentId < right.environmentId ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

function dedupe(values: ReadonlyArray<string>): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

export function buildSidebarProjectSnapshots(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
}): SidebarProjectSnapshot[] {
  const groupedMembers = new Map<string, SidebarProjectGroupMember[]>();
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    const member: SidebarProjectGroupMember = {
      ...project,
      physicalProjectKey: derivePhysicalProjectKey(project),
      environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
    };
    const existing = groupedMembers.get(logicalKey);
    if (existing) {
      existing.push(member);
    } else {
      groupedMembers.set(logicalKey, [member]);
    }
  }
  for (const members of groupedMembers.values()) {
    members.sort(compareMembers);
  }

  const result: SidebarProjectSnapshot[] = [];
  const seen = new Set<string>();
  // The outer loop still walks `input.projects` so row order follows the
  // caller's sort; only the choice of representative *within* a group is
  // normalised above.
  for (const project of input.projects) {
    const logicalKey = deriveLogicalProjectKeyFromSettings(project, input.settings);
    if (seen.has(logicalKey)) {
      continue;
    }
    seen.add(logicalKey);

    const members = groupedMembers.get(logicalKey) ?? [];
    const representative =
      (input.primaryEnvironmentId
        ? members.find((member) => member.environmentId === input.primaryEnvironmentId)
        : null) ?? members[0];
    if (!representative) {
      continue;
    }

    const describeEnvironment = (member: SidebarProjectGroupMember): string =>
      member.environmentLabel ?? member.environmentId;

    const environmentPresence: EnvironmentPresence = (() => {
      if (input.primaryEnvironmentId === null) {
        return "unknown";
      }
      const hasLocal = members.some(
        (member) => member.environmentId === input.primaryEnvironmentId,
      );
      const hasRemote = members.some(
        (member) => member.environmentId !== input.primaryEnvironmentId,
      );
      if (hasLocal && hasRemote) return "mixed";
      return hasRemote ? "remote-only" : "local-only";
    })();

    const remoteEnvironmentLabels = dedupe(
      members
        .filter(
          (member) =>
            input.primaryEnvironmentId === null ||
            member.environmentId !== input.primaryEnvironmentId,
        )
        .map(describeEnvironment),
    );

    result.push({
      ...representative,
      projectKey: logicalKey,
      displayName:
        members.length > 1
          ? deriveProjectGroupLabel({
              representative,
              members,
            })
          : representative.name,
      groupedProjectCount: members.length,
      environmentPresence,
      memberProjects: members,
      memberProjectRefs: members.map((member) => scopeProjectRef(member.environmentId, member.id)),
      remoteEnvironmentLabels,
    });
  }

  return result;
}
