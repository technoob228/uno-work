/**
 * The React side of "which machine am I configuring?" in Settings.
 *
 * Three surfaces need the same answer — the "Applies to" control in the
 * header, the grouped sidebar nav, and the badge on every section — so it is
 * computed once here and read three times, instead of each surface re-deriving
 * the machine list, the current scope and the switch target on its own.
 *
 * The machine list comes from the environments the app can actually address
 * (primary + saved connections), decorated with the plain-language kind and
 * state the "My machines" page shows, so a machine is called the same thing in
 * both places.
 *
 * @module components/settings/useSettingsScope
 */
import type { EnvironmentId, WorkspaceMachineKind } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo } from "react";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { useEnvironmentScopes } from "~/environments/scope/scopes";
import { unoCloudStateQueryOptions, workspaceStateQueryOptions } from "~/lib/workspaceReactQuery";
import { MACHINE_KIND_LABELS, MACHINE_STATUS_LABELS, type MachineStatus } from "~/plainLanguage";
import { useServerConfig } from "~/rpc/serverState";
import { useUiStateStore } from "~/uiStateStore";

import { buildMachineRows } from "./machineRows";
import {
  SETTINGS_SCOPE_SWITCH_HINT,
  parseSettingsScopeLocation,
  resolveSettingsScopeSwitch,
  type SettingsScopeLocation,
  type SettingsScopeTarget,
} from "./settingsScopeRoutes";

/** One machine the user can pick in Settings, in the user's words. */
export interface SettingsMachineOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly kind: WorkspaceMachineKind;
  /** "This computer" / "Uno box" / "Other machine". */
  readonly kindLabel: string;
  readonly status: MachineStatus;
  readonly statusLabel: string;
  readonly isPrimary: boolean;
}

const NO_PROJECTS: ReadonlyMap<string, ReadonlyArray<string>> = new Map();

/**
 * Every machine whose settings this app can open, primary first. Kind and
 * power state are folded in from the same sources as "My machines".
 */
export function useSettingsMachineOptions(): ReadonlyArray<SettingsMachineOption> {
  const scopes = useEnvironmentScopes();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryLabel = useServerConfig()?.environment.label;
  const savedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const registry = useQuery(workspaceStateQueryOptions(primaryEnvironmentId)).data;
  const cloud = useQuery(unoCloudStateQueryOptions(primaryEnvironmentId)).data;

  return useMemo(() => {
    const rowsById = new Map<string, { kind: WorkspaceMachineKind; status: MachineStatus }>();
    if (primaryEnvironmentId) {
      const rows = buildMachineRows({
        primaryEnvironmentId,
        primaryLabel,
        registryMachines: registry?.machines ?? [],
        savedEnvironments: Object.values(savedEnvironments).map((record) => ({
          environmentId: record.environmentId,
          label: record.label,
          lastConnectedAt: record.lastConnectedAt,
        })),
        connectionStateById: Object.fromEntries(
          Object.entries(runtimeById).map(([id, runtime]) => [id, runtime.connectionState]),
        ),
        boxes: cloud?.connected ? cloud.boxes : [],
        projectNamesByEnvironmentId: NO_PROJECTS,
        now: Date.now(),
      });
      for (const row of rows) {
        if (row.environmentId) {
          rowsById.set(row.environmentId, { kind: row.kind, status: row.status });
        }
      }
    }

    return scopes.map((scope): SettingsMachineOption => {
      const row = rowsById.get(scope.environmentId);
      const kind: WorkspaceMachineKind =
        row?.kind ?? (scope.placement === "local" ? "local" : "ssh");
      // A live connection is the one fact Settings must not get wrong: writes
      // go through it. Anything else shows the registry's word (sleeping box,
      // offline), falling back to offline.
      const status: MachineStatus =
        scope.availability.status === "connected"
          ? "online"
          : row?.status === "sleeping"
            ? "sleeping"
            : "offline";
      return {
        environmentId: scope.environmentId,
        label: scope.label,
        kind,
        kindLabel: MACHINE_KIND_LABELS[kind],
        status,
        statusLabel: MACHINE_STATUS_LABELS[status],
        isPrimary: scope.environmentId === primaryEnvironmentId,
      };
    });
  }, [cloud, primaryEnvironmentId, primaryLabel, registry, runtimeById, savedEnvironments, scopes]);
}

export interface SettingsScopeModel {
  readonly location: SettingsScopeLocation;
  readonly machines: ReadonlyArray<SettingsMachineOption>;
  /**
   * The machine whose settings the page edits (environment scope), or the
   * machine the "Machine:" nav group describes while an app-scoped page is
   * open — the last one configured, else the primary.
   */
  readonly selectedMachine: SettingsMachineOption | null;
  /** True when the URL names a machine the app no longer has. */
  readonly unknownMachine: boolean;
  readonly switchTo: (target: SettingsScopeTarget) => void;
}

/**
 * Current scope, the machines to offer, and the one action that moves between
 * them. Remembers the scope of every Settings page it sees so "open Settings"
 * can come back to the same machine.
 */
export function useSettingsScopeModel(pathname: string): SettingsScopeModel {
  const navigate = useNavigate();
  const machines = useSettingsMachineOptions();
  const location = useMemo(() => parseSettingsScopeLocation(pathname), [pathname]);
  const memory = useUiStateStore((state) => state.settingsScopeMemory);
  const rememberSettingsScope = useUiStateStore((state) => state.rememberSettingsScope);
  const setSettingsScopeNotice = useUiStateStore((state) => state.setSettingsScopeNotice);
  const knownEnvironmentIds = useMemo(
    () => machines.map((machine) => machine.environmentId),
    [machines],
  );

  useEffect(() => {
    if (!pathname.startsWith("/settings")) return;
    rememberSettingsScope({ kind: location.kind, environmentId: location.environmentId });
  }, [location.environmentId, location.kind, pathname, rememberSettingsScope]);

  const selectedMachine = useMemo(() => {
    const wantedId =
      location.kind === "environment"
        ? location.environmentId
        : (memory.machineEnvironmentId ?? machines[0]?.environmentId ?? null);
    return (
      machines.find((machine) => machine.environmentId === wantedId) ??
      (location.kind === "environment" ? null : (machines[0] ?? null))
    );
  }, [location.environmentId, location.kind, machines, memory.machineEnvironmentId]);

  const unknownMachine =
    location.kind === "environment" &&
    location.environmentId !== null &&
    !knownEnvironmentIds.includes(location.environmentId);

  const switchTo = useCallback(
    (target: SettingsScopeTarget) => {
      const result = resolveSettingsScopeSwitch({
        section: location.section,
        target,
        knownEnvironmentIds,
      });
      setSettingsScopeNotice(
        result.keptSection ? null : { pathname: result.to, message: SETTINGS_SCOPE_SWITCH_HINT },
      );
      void navigate({ to: result.to, replace: true });
    },
    [knownEnvironmentIds, location.section, navigate, setSettingsScopeNotice],
  );

  return { location, machines, selectedMachine, unknownMachine, switchTo };
}

/**
 * What the badge on a settings section says about where the setting lives.
 * Provided by the Settings layout; `null` outside Settings so shared section
 * headers elsewhere stay unchanged.
 */
export type SettingsScopeBadgeInfo =
  | { readonly kind: "app" }
  | { readonly kind: "environment"; readonly machineLabel: string };

export const SettingsScopeBadgeContext = createContext<SettingsScopeBadgeInfo | null>(null);

export function useSettingsScopeBadge(): SettingsScopeBadgeInfo | null {
  return useContext(SettingsScopeBadgeContext);
}

export function settingsScopeBadgeInfo(model: SettingsScopeModel): SettingsScopeBadgeInfo {
  if (model.location.kind === "app") return { kind: "app" };
  return {
    kind: "environment",
    machineLabel: model.unknownMachine
      ? "Unknown machine"
      : (model.selectedMachine?.label ?? "Unknown machine"),
  };
}
