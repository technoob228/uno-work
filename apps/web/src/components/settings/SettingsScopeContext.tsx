/**
 * The scope a settings page applies to, read by the sentence, the rows and
 * their source badges. Ported from T3 Code, on our machine list.
 *
 * @module components/settings/SettingsScopeContext
 */
import { createContext, type ReactNode, useContext, useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useServerConfig } from "../../rpc/serverState";
import {
  resolveScopedSettingsTargets,
  type ScopedSettingsEnvironment,
  selectScopedSettingsEnvironments,
} from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { type SettingsMachineOption, useSettingsMachineOptions } from "./useSettingsScope";

export type ScopedEnvironment = SettingsMachineOption & ScopedSettingsEnvironment;

function useScopedEnvironments(): readonly ScopedEnvironment[] {
  const machines = useSettingsMachineOptions();
  const primaryConfig = useServerConfig();
  const savedById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useMemo(
    () =>
      machines.map((machine) => ({
        ...machine,
        connected: machine.status === "online",
        serverConfig: machine.isPrimary
          ? primaryConfig
          : (savedById[machine.environmentId]?.serverConfig ?? null),
      })),
    [machines, primaryConfig, savedById],
  );
}

function useResolvedSettingsScope(rawSearch: SettingsScopeSearch) {
  const environments = useScopedEnvironments();
  const groups = useSettingsProjectGroups(environments);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const singleComputer = environments.length <= 1;
  // One computer: "all of them" and "this one" are the same choice.
  const search: SettingsScopeSearch =
    singleComputer && rawSearch.machine === environments[0]?.environmentId
      ? { ...(rawSearch.project ? { project: rawSearch.project } : {}) }
      : rawSearch;
  const scope = resolveSettingsScope(search, groups, environments);
  const selected = selectScopedSettingsEnvironments(scope, environments, primaryEnvironmentId);
  const targets = resolveScopedSettingsTargets(scope, selected.connectedEnvironments);
  const target =
    targets.find((candidate) => candidate.environmentId === selected.environment?.environmentId) ??
    targets[0] ??
    null;
  return {
    scope,
    groups,
    search,
    allEnvironments: environments,
    singleComputer,
    ...selected,
    targets,
    target,
  };
}

export type SettingsScopeValue = ReturnType<typeof useResolvedSettingsScope> & {
  /** Rows for one project or for every computer: machine-only rows step aside. */
  readonly wideScope: boolean;
  readonly selectScope: (next: SettingsScopeSearch) => void;
};

const SettingsScopeContext = createContext<SettingsScopeValue | null>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
}: {
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search);
  const wideScope =
    resolved.scope.kind === "project" ||
    (resolved.scope.kind === "all" && !resolved.singleComputer);
  const value = { ...resolved, wideScope, selectScope: onChange };
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
