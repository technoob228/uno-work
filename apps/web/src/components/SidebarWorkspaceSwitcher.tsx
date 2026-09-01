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
  CloudIcon,
  LayersIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  SettingsIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, WorkspaceMachineKind } from "@t3tools/contracts";

import { AddEnvModal } from "./AddEnvModal";
import { cn } from "../lib/utils";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useReconnectEnvironment } from "../hooks/useReconnectEnvironment";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { useWorkspaces, type WorkspaceSummary } from "../lib/useWorkspaces";
import { selectSidebarThreadsForEnvironment, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { pickThreadForEnvironmentSwitch } from "./Sidebar.logic";
import { MachineChip } from "./MachineChip";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";

const MACHINE_KIND_ICON: Record<WorkspaceMachineKind, typeof MonitorIcon> = {
  local: MonitorIcon,
  ssh: ServerIcon,
  uno_box: CloudIcon,
};

export function SidebarWorkspaceSwitcher() {
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

  const triggerTitle = currentWorkspace?.name ?? (isLoading ? "Loading workspace…" : "Workspace");
  const machineCount = currentWorkspace?.machines.length ?? 0;
  const triggerSubtitle = currentMachine
    ? `${currentMachine.machine.label} · 1 of ${machineCount}`
    : currentWorkspace
      ? `whole workspace · ${machineCount} ${machineCount === 1 ? "machine" : "machines"}`
      : "No workspace yet";

  const pendingCount = currentWorkspace?.pendingRequestCount ?? 0;

  return (
    <>
      <div className="flex w-full items-stretch gap-1">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left transition-colors hover:bg-accent"
                aria-label="Switch workspace"
              >
                <LayersIcon className="size-3.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{triggerTitle}</div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {triggerSubtitle}
                  </div>
                </div>
                {pendingCount > 0 ? (
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                    {pendingCount}
                  </span>
                ) : null}
                <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
              </button>
            }
          />
          <MenuPopup align="start" side="top" sideOffset={6} className="min-w-[17rem] p-1">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Workspaces
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
                        ? ` · ${workspace.unreachableCount} unreachable`
                        : ""}
                      {` · rev ${workspace.epoch}`}
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
                {isLoading ? "Reading the registry…" : "No workspace registry answered yet."}
              </div>
            ) : null}

            {currentWorkspace && currentWorkspace.machines.length > 0 ? (
              <>
                <div className="my-1 h-px bg-border" />
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Machines in {currentWorkspace.name}
                </div>
                {currentWorkspace.machines.map((entry) => {
                  const Icon = MACHINE_KIND_ICON[entry.machine.kind];
                  const isCurrent =
                    environmentScope === "active" &&
                    entry.machine.environmentId === currentEnvironmentId;
                  return (
                    <button
                      key={entry.machine.environmentId}
                      type="button"
                      disabled={!entry.connected}
                      onClick={() => openMachine(entry.machine.environmentId)}
                      title={
                        entry.connected
                          ? entry.machine.label
                          : `${entry.machine.label} — in the workspace, but this client has no connection to it`
                      }
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                        isCurrent && "bg-accent/60",
                        !entry.connected && "cursor-not-allowed opacity-55 hover:bg-transparent",
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
                        <div className="truncate font-medium">{entry.machine.label}</div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {entry.connected ? "connected" : "not connected"}
                        </div>
                      </div>
                      {isCurrent ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                    </button>
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
              <span>Manage workspace…</span>
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
            className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
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
