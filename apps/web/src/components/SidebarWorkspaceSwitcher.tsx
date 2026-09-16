/**
 * The sidebar's top-level control: which **workspace** you are looking at.
 *
 * This used to switch machines. Machines are now one level down, because that
 * is the order the work actually has: you think "the UNO workspace", and only
 * then "…on the server". Picking a workspace shows every machine in it at
 * once (scope `all`); picking a machine narrows to that one (scope `active`).
 *
 * A workspace's machines come from its registry, not from this client's
 * connection list, so a machine that was adopted but never connected — a
 * sleeping box — is listed and marked unreachable rather than quietly missing.
 */
import {
  CheckIcon,
  ChevronsUpDownIcon,
  LayersIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  StarIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";

import { AddEnvModal } from "./AddEnvModal";
import { cn } from "../lib/utils";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useDefaultEnvironment } from "../hooks/useDefaultEnvironment";
import { useMachineRows } from "../hooks/useMachineRows";
import { useReconnectEnvironment } from "../hooks/useReconnectEnvironment";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import {
  useEnsureOwnMachineRegistered,
  useWorkspaces,
  type WorkspaceSummary,
} from "../lib/useWorkspaces";
import { deriveMachineKind, type MachineKind } from "../machineKind";
import { MACHINE_KIND_LABELS } from "../plainLanguage";
import { selectSidebarThreadsForEnvironment, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { pickThreadForEnvironmentSwitch } from "./Sidebar.logic";
import { MachineChip } from "./MachineChip";
import { MACHINE_KIND_ICON } from "./machineKindIcons";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";

/** See SidebarEnvSwitcher for the `card` / `compact` variants. */
export function SidebarWorkspaceSwitcher({
  variant = "card",
}: { variant?: "card" | "compact" } = {}) {
  const navigate = useNavigate();
  const [addEnvOpen, setAddEnvOpen] = useState(false);
  const { reconnect, reconnectingId } = useReconnectEnvironment();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  const sidebarThreadSortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);
  const environmentScope = useSettings((settings) => settings.sidebarEnvironmentScope);
  const { updateSettings } = useUpdateSettings();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const machineRows = useMachineRows();
  const { explicitDefaultId, setDefaultEnvironment } = useDefaultEnvironment();
  // Kind per machine from the shared fold, so a box is a box here as well as
  // in My machines; a registry-only machine falls back to the registry's word.
  const kindById = useMemo(() => {
    const map = new Map<string, MachineKind>();
    for (const row of machineRows) {
      if (row.environmentId) map.set(row.environmentId, row.kind);
    }
    return map;
  }, [machineRows]);

  useEnsureOwnMachineRegistered();
  const { workspaces, isLoading } = useWorkspaces();

  const currentEnvironmentId = activeEnvironmentId ?? primaryEnvironmentId ?? null;

  /**
   * The workspace on screen is the one containing the environment we are
   * pointed at — not "the first one", which would jump around as registries
   * load in a different order.
   */
  const currentWorkspace = useMemo<WorkspaceSummary | null>(() => {
    if (workspaces.length === 0) return null;
    const containing = workspaces.find(
      (workspace) =>
        workspace.registryEnvironmentId === currentEnvironmentId ||
        workspace.machines.some((entry) => entry.machine.environmentId === currentEnvironmentId),
    );
    return containing ?? workspaces[0] ?? null;
  }, [currentEnvironmentId, workspaces]);

  const currentMachine = useMemo(() => {
    if (!currentWorkspace || environmentScope === "all") return null;
    return (
      currentWorkspace.machines.find(
        (entry) => entry.machine.environmentId === currentEnvironmentId,
      ) ?? null
    );
  }, [currentEnvironmentId, currentWorkspace, environmentScope]);

  const currentSavedEnvironment = currentEnvironmentId
    ? savedEnvironmentRegistry[currentEnvironmentId]
    : null;
  const currentConnectionState = currentEnvironmentId
    ? (runtimeById[currentEnvironmentId]?.connectionState ??
      (currentEnvironmentId === primaryEnvironmentId ? "connected" : "disconnected"))
    : "disconnected";
  const canReconnectCurrent =
    currentSavedEnvironment != null &&
    (currentConnectionState === "disconnected" || currentConnectionState === "error");
  const isReconnectingCurrent =
    currentEnvironmentId != null && reconnectingId === currentEnvironmentId;

  const openWorkspace = (workspace: WorkspaceSummary) => {
    // Selecting a workspace means "show me all of it": the registry daemon
    // becomes the connection we talk to, and the sidebar unions every machine.
    updateSettings({ sidebarEnvironmentScope: "all" });
    switchEnvironment(workspace.registryEnvironmentId);
  };

  const openMachine = (environmentId: EnvironmentId) => {
    updateSettings({ sidebarEnvironmentScope: "active" });
    switchEnvironment(environmentId);
  };

  const switchEnvironment = (environmentId: EnvironmentId) => {
    setActiveEnvironmentId(environmentId);
    const threads = selectSidebarThreadsForEnvironment(useStore.getState(), environmentId);
    const lastVisitedById = useUiStateStore.getState().threadLastVisitedAtById;
    const target = pickThreadForEnvironmentSwitch(threads, lastVisitedById, sidebarThreadSortOrder);
    if (target) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId: target.id }),
      });
      return;
    }
    void navigate({ to: "/" });
  };

  const triggerTitle = currentWorkspace?.name ?? (isLoading ? "Loading machines…" : "Machines");
  const machineCount = currentWorkspace?.machines.length ?? 0;
  const triggerSubtitle = currentMachine
    ? `${currentMachine.machine.label} · 1 of ${machineCount}`
    : currentWorkspace
      ? `all machines · ${machineCount} ${machineCount === 1 ? "machine" : "machines"}`
      : "No machines yet";

  return (
    <>
      <div className="flex w-full items-stretch gap-1">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-colors",
                  variant === "compact"
                    ? "h-8 px-2 text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
                    : "border border-border bg-background px-2 py-1.5 hover:bg-accent",
                )}
                aria-label="Switch machine"
                title={variant === "compact" ? `${triggerTitle} · ${triggerSubtitle}` : undefined}
              >
                <LayersIcon className="size-3.5 shrink-0 text-primary" />
                {variant === "compact" ? (
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {triggerTitle}
                  </span>
                ) : (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground">
                      {triggerTitle}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {triggerSubtitle}
                    </div>
                  </div>
                )}
                <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
              </button>
            }
          />
          <MenuPopup align="start" side="top" sideOffset={6} className="min-w-[17rem] p-1">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              My machines
            </div>
            {workspaces.map((workspace) => {
              const isCurrent = workspace.workspaceId === currentWorkspace?.workspaceId;
              return (
                <button
                  key={workspace.workspaceId}
                  type="button"
                  onClick={() => openWorkspace(workspace)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                    isCurrent && environmentScope === "all" && "bg-accent/60",
                  )}
                >
                  <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{workspace.name}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {workspace.machines.length}{" "}
                      {workspace.machines.length === 1 ? "machine" : "machines"}
                      {workspace.unreachableCount > 0
                        ? ` · ${workspace.unreachableCount} not connected`
                        : ""}
                    </div>
                  </div>
                  {isCurrent && environmentScope === "all" ? (
                    <CheckIcon className="size-3.5 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })}
            {workspaces.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                {isLoading ? "Looking for machines…" : "No machines found yet."}
              </div>
            ) : null}

            {currentWorkspace && currentWorkspace.machines.length > 0 ? (
              <>
                <div className="my-1 h-px bg-border" />
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Machines
                </div>
                {currentWorkspace.machines.map((entry) => {
                  const kind =
                    kindById.get(entry.machine.environmentId) ??
                    deriveMachineKind({ registryKind: entry.machine.kind });
                  const Icon = MACHINE_KIND_ICON[kind];
                  const isCurrent =
                    environmentScope === "active" &&
                    entry.machine.environmentId === currentEnvironmentId;
                  const isDefault = explicitDefaultId === entry.machine.environmentId;
                  return (
                    <div
                      key={entry.machine.environmentId}
                      className={cn(
                        "group/machine flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent",
                        isCurrent && "bg-accent/60",
                        !entry.connected && "opacity-55 hover:bg-transparent",
                      )}
                    >
                      <button
                        type="button"
                        disabled={!entry.connected}
                        onClick={() => openMachine(entry.machine.environmentId)}
                        title={
                          entry.connected
                            ? entry.machine.label
                            : `${entry.machine.label} — listed, but not connected from here`
                        }
                        className={cn(
                          "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                          !entry.connected && "cursor-not-allowed",
                        )}
                      >
                        <MachineChip
                          identity={{
                            environmentId: entry.machine.environmentId,
                            label: entry.machine.label,
                            monogram: entry.machine.monogram,
                            colorSlot: entry.machine.colorSlot,
                            isMonogramOverridden: true,
                          }}
                          size="sm"
                          withoutTooltip
                        />
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium">{entry.machine.label}</span>
                            {isDefault ? (
                              <span className="shrink-0 text-[10px] font-normal text-primary">
                                Default
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-[10px] text-muted-foreground">
                            {MACHINE_KIND_LABELS[kind]} ·{" "}
                            {entry.connected ? "connected" : "not connected"}
                          </div>
                        </div>
                        {isCurrent ? (
                          <CheckIcon className="size-3.5 shrink-0 text-primary" />
                        ) : null}
                      </button>
                      {entry.connected ? (
                        <button
                          type="button"
                          onClick={() =>
                            setDefaultEnvironment(isDefault ? null : entry.machine.environmentId)
                          }
                          aria-pressed={isDefault}
                          aria-label={
                            isDefault
                              ? `Stop using ${entry.machine.label} as the default machine`
                              : `Make ${entry.machine.label} the default machine`
                          }
                          title={isDefault ? "Default machine" : "Make this the default machine"}
                          className={cn(
                            "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:text-foreground",
                            isDefault
                              ? "text-primary opacity-100"
                              : "opacity-0 focus-visible:opacity-100 group-hover/machine:opacity-100",
                          )}
                        >
                          <StarIcon
                            className={cn("size-3.5", isDefault && "fill-current")}
                            aria-hidden="true"
                          />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </>
            ) : null}

            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              onClick={() => void navigate({ to: "/settings/workspace" })}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            >
              <SettingsIcon className="size-3.5" />
              <span>Manage my machines…</span>
            </button>
            <button
              type="button"
              onClick={() => setAddEnvOpen(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/8"
            >
              <PlusIcon className="size-3.5" />
              <span>Add a machine</span>
            </button>
          </MenuPopup>
        </Menu>
        {canReconnectCurrent ? (
          <button
            type="button"
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
              variant === "compact"
                ? "size-8 hover:bg-sidebar-row-hover"
                : "size-9 border border-border bg-background hover:bg-accent",
            )}
            disabled={isReconnectingCurrent}
            title="Reconnect machine"
            aria-label="Reconnect machine"
            onClick={() => {
              if (currentEnvironmentId) void reconnect(currentEnvironmentId);
            }}
          >
            <RefreshCwIcon className={cn("size-3.5", isReconnectingCurrent && "animate-spin")} />
          </button>
        ) : null}
      </div>
      <AddEnvModal open={addEnvOpen} onOpenChange={setAddEnvOpen} />
    </>
  );
}
