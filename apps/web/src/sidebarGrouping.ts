/**
 * Building the sidebar tree along the two dimensions a chat belongs to: the
 * project it is in and the machine it runs on.
 *
 * Four modes, one renderer. `"project"` and `"machine"` are mirrors — the same
 * two-level shape with the roles swapped, where the dimension that is *not*
 * grouping is carried as a marker on the chat row. The two-level modes spend a
 * third level of nesting to make that dimension a sub-heading instead.
 *
 * Everything here is pure so the tree can be asserted directly. Sorting inside
 * a level is the caller's existing concern (project and thread sort orders are
 * already implemented elsewhere); this module only orders *machines* and slices
 * the data into groups.
 */

import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarMachineSortOrder } from "@t3tools/contracts/settings";

import type { ProjectGroupingSettings } from "./logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "./sidebarProjectGrouping";
import type { Project, SidebarThreadSummary } from "./types";

export interface SidebarMachineGroup {
  readonly environmentId: EnvironmentId;
  /** Projects that exist on this machine, grouped the usual way. */
  readonly projects: readonly SidebarProjectSnapshot[];
  /** Every chat on this machine, in the order the caller supplied them. */
  readonly threads: readonly SidebarThreadSummary[];
  /**
   * Most recent activity on this machine, for activity sorting. `null` when the
   * machine has no chats — which is a real state (a freshly attached machine),
   * not an error.
   */
  readonly lastActivityAt: string | null;
}

export interface SidebarThreadEnvironmentPartition {
  readonly environmentId: EnvironmentId;
  readonly threads: readonly SidebarThreadSummary[];
}

function threadActivityAt(thread: SidebarThreadSummary): string | null {
  return thread.updatedAt ?? thread.latestUserMessageAt ?? thread.createdAt ?? null;
}

function laterOf(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left >= right ? left : right;
}

/**
 * Order machines for display.
 *
 * Every branch ends in a comparison on `environmentId` so the result is a total
 * order: without that, machines with equal activity (or equal labels, which
 * happens routinely because labels come from hostnames) could swap places
 * between renders and take their expanded/collapsed state with them.
 */
export function sortMachineEnvironmentIds(input: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly sortOrder: SidebarMachineSortOrder;
  readonly manualOrder: readonly string[];
  readonly resolveLabel: (environmentId: EnvironmentId) => string | null;
  readonly resolveLastActivityAt: (environmentId: EnvironmentId) => string | null;
}): EnvironmentId[] {
  const byId = (left: EnvironmentId, right: EnvironmentId): number =>
    left === right ? 0 : left < right ? -1 : 1;

  if (input.sortOrder === "manual") {
    const rank = new Map<string, number>();
    input.manualOrder.forEach((environmentId, index) => {
      if (!rank.has(environmentId)) {
        rank.set(environmentId, index);
      }
    });
    return [...input.environmentIds].sort((left, right) => {
      const leftRank = rank.get(left) ?? Number.POSITIVE_INFINITY;
      const rightRank = rank.get(right) ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return byId(left, right);
    });
  }

  if (input.sortOrder === "name") {
    return [...input.environmentIds].sort((left, right) => {
      const leftLabel = input.resolveLabel(left) ?? left;
      const rightLabel = input.resolveLabel(right) ?? right;
      const byLabel = leftLabel.localeCompare(rightLabel);
      return byLabel !== 0 ? byLabel : byId(left, right);
    });
  }

  return [...input.environmentIds].sort((left, right) => {
    const leftAt = input.resolveLastActivityAt(left);
    const rightAt = input.resolveLastActivityAt(right);
    if (leftAt !== rightAt) {
      // Machines with no activity sort last rather than first: an idle machine
      // is not news.
      if (leftAt === null) {
        return 1;
      }
      if (rightAt === null) {
        return -1;
      }
      return leftAt > rightAt ? -1 : 1;
    }
    return byId(left, right);
  });
}

/**
 * Split projects and chats into per-machine groups.
 *
 * `environmentIds` is the authoritative list of machines to show, so a machine
 * that is connected but has nothing on it still gets a row — otherwise there
 * would be no way to see it, or to start work there. Machines that only appear
 * in the data are appended rather than dropped: losing a chat because its
 * machine was missing from a list would be the worst possible failure here.
 */
export function buildSidebarMachineGroups(input: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly settings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
  readonly sortOrder: SidebarMachineSortOrder;
  readonly manualOrder: readonly string[];
}): SidebarMachineGroup[] {
  const projectsByEnvironment = new Map<EnvironmentId, Project[]>();
  for (const project of input.projects) {
    const existing = projectsByEnvironment.get(project.environmentId);
    if (existing) {
      existing.push(project);
    } else {
      projectsByEnvironment.set(project.environmentId, [project]);
    }
  }

  const threadsByEnvironment = new Map<EnvironmentId, SidebarThreadSummary[]>();
  const activityByEnvironment = new Map<EnvironmentId, string | null>();
  for (const thread of input.threads) {
    const existing = threadsByEnvironment.get(thread.environmentId);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByEnvironment.set(thread.environmentId, [thread]);
    }
    activityByEnvironment.set(
      thread.environmentId,
      laterOf(activityByEnvironment.get(thread.environmentId) ?? null, threadActivityAt(thread)),
    );
  }

  const known = new Set<EnvironmentId>(input.environmentIds);
  const extras: EnvironmentId[] = [];
  for (const environmentId of [...projectsByEnvironment.keys(), ...threadsByEnvironment.keys()]) {
    if (!known.has(environmentId)) {
      known.add(environmentId);
      extras.push(environmentId);
    }
  }

  const ordered = sortMachineEnvironmentIds({
    environmentIds: [...input.environmentIds, ...extras],
    sortOrder: input.sortOrder,
    manualOrder: input.manualOrder,
    resolveLabel: input.resolveEnvironmentLabel,
    resolveLastActivityAt: (environmentId) => activityByEnvironment.get(environmentId) ?? null,
  });

  return ordered.map((environmentId) => ({
    environmentId,
    projects: buildSidebarProjectSnapshots({
      projects: projectsByEnvironment.get(environmentId) ?? [],
      settings: input.settings,
      primaryEnvironmentId: input.primaryEnvironmentId,
      resolveEnvironmentLabel: input.resolveEnvironmentLabel,
    }),
    threads: threadsByEnvironment.get(environmentId) ?? [],
    lastActivityAt: activityByEnvironment.get(environmentId) ?? null,
  }));
}

/**
 * Group one project's chats by machine, for the `project_machine` mode.
 *
 * `environmentOrder` comes from the machine sort so sub-headings under two
 * different projects appear in the same sequence; environments outside it keep
 * their first-appearance order rather than being dropped.
 */
export function partitionThreadsByEnvironment(input: {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly environmentOrder: readonly EnvironmentId[];
}): SidebarThreadEnvironmentPartition[] {
  const grouped = new Map<EnvironmentId, SidebarThreadSummary[]>();
  for (const thread of input.threads) {
    const existing = grouped.get(thread.environmentId);
    if (existing) {
      existing.push(thread);
    } else {
      grouped.set(thread.environmentId, [thread]);
    }
  }
  const rank = new Map<string, number>();
  input.environmentOrder.forEach((environmentId, index) => {
    if (!rank.has(environmentId)) {
      rank.set(environmentId, index);
    }
  });
  return [...grouped.entries()]
    .sort(([left], [right]) => {
      const leftRank = rank.get(left) ?? Number.POSITIVE_INFINITY;
      const rightRank = rank.get(right) ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left === right ? 0 : left < right ? -1 : 1;
    })
    .map(([environmentId, threads]) => ({ environmentId, threads }));
}
