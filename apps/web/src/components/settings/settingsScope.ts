/**
 * What a settings page applies to: which project, on which computers. Ported
 * from T3 Code. The computer lives in the path on machine pages; the sentence
 * adds `?project=` and `?machine=all` on top, so a reload and a bookmark keep
 * the same scope.
 *
 * @module components/settings/settingsScope
 */
import type { EnvironmentId } from "@t3tools/contracts";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";

export const ALL_COMPUTERS_VALUE = "all";
export const ALL_PROJECTS_VALUE = "all";

export interface SettingsScopeSearch {
  project?: string | undefined;
  /** A computer's id, or "all". Absent: the path's computer, else all of them. */
  machine?: string | undefined;
}

export interface ScopeComputer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

type ScopeTargets = {
  label: string;
  members: readonly SidebarProjectGroupMember[];
  environmentIds: readonly EnvironmentId[];
};

export type ResolvedSettingsScope = ScopeTargets &
  (
    | { kind: "all" }
    | { kind: "environment"; environmentId: EnvironmentId }
    | { kind: "project"; group: SidebarProjectSnapshot; environmentId: EnvironmentId | null }
    | {
        kind: "unavailable";
        reason: "project-missing" | "environment-missing" | "checkout-missing";
        message: string;
      }
  );

/** Stale ids stay in the search, so a removed target reads as unavailable, not as "all". */
export function validateSettingsScopeSearch(raw: Record<string, unknown>): SettingsScopeSearch {
  const stringValue = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const project = stringValue(raw.project);
  const machine = stringValue(raw.machine);
  return {
    ...(project === undefined ? {} : { project }),
    ...(machine === undefined ? {} : { machine }),
  };
}

/** Machine pages name their computer in the path; only "all" can widen that. */
export function effectiveScopeSearch(
  search: SettingsScopeSearch,
  pathEnvironmentId: EnvironmentId | null,
): SettingsScopeSearch {
  const machine =
    pathEnvironmentId === null
      ? search.machine === ALL_COMPUTERS_VALUE
        ? undefined
        : search.machine
      : search.machine === ALL_COMPUTERS_VALUE
        ? undefined
        : pathEnvironmentId;
  return {
    ...(search.project === undefined ? {} : { project: search.project }),
    ...(machine === undefined ? {} : { machine }),
  };
}

/** An unavailable selection never broadens a later write. */
export function resolveSettingsScope(
  search: SettingsScopeSearch,
  groups: readonly SidebarProjectSnapshot[],
  environments: readonly ScopeComputer[],
): ResolvedSettingsScope {
  const unavailable = (
    reason: Extract<ResolvedSettingsScope, { kind: "unavailable" }>["reason"],
    message: string,
  ): ResolvedSettingsScope => ({
    kind: "unavailable",
    reason,
    label: "Unavailable selection",
    message,
    members: [],
    environmentIds: [],
  });

  const environment = environments.find((candidate) => candidate.environmentId === search.machine);
  if (search.machine && !environment) {
    return unavailable("environment-missing", "This computer is no longer available.");
  }

  if (search.project) {
    const group = groups.find((candidate) => candidate.projectKey === search.project);
    if (!group) return unavailable("project-missing", "This project is no longer available.");
    const members = group.memberProjects.filter(
      (member) => search.machine === undefined || member.environmentId === search.machine,
    );
    if (members.length === 0) {
      return unavailable("checkout-missing", "This project isn't on this computer.");
    }
    return {
      kind: "project",
      group,
      environmentId: environment?.environmentId ?? null,
      label: `${group.displayName} / ${environment?.label ?? "All computers"}`,
      members,
      environmentIds: [...new Set(members.map((member) => member.environmentId))],
    };
  }
  if (environment) {
    return {
      kind: "environment",
      environmentId: environment.environmentId,
      label: environment.label,
      members: [],
      environmentIds: [environment.environmentId],
    };
  }
  return {
    kind: "all",
    label: "All computers",
    members: [],
    environmentIds: environments.map((candidate) => candidate.environmentId),
  };
}

/** Picks a computer, keeping the project. Going to "all" uses the explicit value. */
export function selectComputerAxis(
  search: SettingsScopeSearch,
  value: string,
): SettingsScopeSearch {
  return {
    ...(search.project ? { project: search.project } : {}),
    machine: value,
  };
}

/** Picks a project, keeping the computer. */
export function selectProjectAxis(search: SettingsScopeSearch, value: string): SettingsScopeSearch {
  return {
    ...(value === ALL_PROJECTS_VALUE ? {} : { project: value }),
    ...(search.machine ? { machine: search.machine } : {}),
  };
}

/** Only the projects on the chosen computer; a project elsewhere can't be set here. */
export function projectsForComputer(
  groups: readonly SidebarProjectSnapshot[],
  machine: string | undefined,
): readonly SidebarProjectSnapshot[] {
  if (machine === undefined) return groups;
  return groups.filter((group) =>
    group.memberProjects.some((member) => member.environmentId === machine),
  );
}
