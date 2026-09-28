/**
 * The computer switcher's data and actions: the machines this app knows
 * (grouped by kind, default first), the account's cloud computers not
 * connected yet, "Use this computer", reconnect, default machine, "Add
 * computer". One source for every place that switches computers — today the
 * computer menu in Home's header (and the legacy sidebar's card).
 */
import type { EnvironmentConnectionState, EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useDefaultEnvironment } from "../../hooks/useDefaultEnvironment";
import { useLocalDaemonDiscovery, useUseThisComputer } from "../../hooks/useLocalDaemon";
import { useMachineRows } from "../../hooks/useMachineRows";
import { useReconnectEnvironment } from "../../hooks/useReconnectEnvironment";
import { useSwitchEnvironment } from "../../hooks/useSwitchEnvironment";
import { deriveMachineKind, type MachineKind } from "../../machineKind";
import { useStore } from "../../store";
import { formatElapsedAgoLabel } from "../../timestampFormat";
import { connectUnoBox, describeUnoBoxConnectProgress } from "../../unoBoxConnect";
import { groupSwitcherMachines, type SwitcherMachine } from "../SidebarEnvSwitcher.logic";
import { toastManager } from "../ui/toast";

const FALLBACK_ENV = {
  name: "This machine",
  meta: "Starting...",
  kind: "server",
  connectionState: "connecting",
  isPrimary: true,
  isDefault: false,
} as const satisfies Omit<SwitcherMachine, "id">;

export const STATUS_DOT_CLASS: Record<EnvironmentConnectionState, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  reconnecting: "bg-amber-500 animate-pulse",
  disconnected: "bg-muted-foreground/40",
  error: "bg-red-500",
};

function formatPlatformMeta(os: string, arch: string): string {
  const osLabel =
    os === "darwin" ? "macOS" : os === "windows" ? "Windows" : os === "linux" ? "Linux" : os;
  return `${osLabel} ${arch}`.trim();
}

function formatSavedEnvironmentMeta(input: {
  readonly httpBaseUrl: string;
  readonly desktopSshAlias?: string | null;
}): string {
  try {
    return new URL(input.httpBaseUrl).host;
  } catch {
    const alias = input.desktopSshAlias?.trim();
    if (alias) {
      return alias;
    }
    const fallback = input.httpBaseUrl.trim();
    return fallback.length > 0 ? fallback : "Saved machine";
  }
}

function formatSavedEnvironmentStatusMeta(input: {
  readonly connectionState: EnvironmentConnectionState;
  readonly lastSynchronizedAt: string | null;
  readonly details: string;
}): string {
  const lastSync = input.lastSynchronizedAt
    ? formatElapsedAgoLabel(input.lastSynchronizedAt)
    : null;

  switch (input.connectionState) {
    case "connected":
      return `Synced · ${input.details}`;
    case "connecting":
      return `Connecting · ${input.details}`;
    case "reconnecting":
      return `${lastSync ? `Reconnecting · cached ${lastSync}` : "Reconnecting"} · ${input.details}`;
    case "error":
      return `${lastSync ? `Error · cached ${lastSync}` : "Connection error"} · ${input.details}`;
    case "disconnected":
      return `${lastSync ? `Offline · cached ${lastSync}` : "Offline · never synced"} · ${input.details}`;
  }
}

/** What the desktop app calls the computer it runs on. */
function localComputerName(os: string): string {
  return os === "darwin" ? "This Mac" : "This computer";
}

/**
 * `onDone` runs when a pick takes the person somewhere (switch, connect,
 * "All computers") — the owner closes its menu.
 */
export function useComputerSwitcher(onDone?: () => void) {
  const [addEnvOpen, setAddEnvOpen] = useState(false);
  const navigate = useNavigate();
  const [connecting, setConnecting] = useState<{ boxId: number; label: string } | null>(null);
  const { reconnect, reconnectingId } = useReconnectEnvironment();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const primaryEnvironmentId = primaryDescriptor?.environmentId ?? null;
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const switchEnvironment = useSwitchEnvironment();
  const machineRows = useMachineRows();
  const { explicitDefaultId, setDefaultEnvironment } = useDefaultEnvironment();
  // Browser build only: a Uno Work desktop on this very computer that is not
  // yet one of the saved machines gets a one-click "Use this computer".
  const { daemon: localDaemon } = useLocalDaemonDiscovery();
  const useThisComputer = useUseThisComputer();
  const unlinkedLocalDaemon =
    localDaemon && !savedEnvironmentRegistry[localDaemon.environmentId] ? localDaemon : null;

  const environments = useMemo<SwitcherMachine[]>(() => {
    // Kinds come from the shared fold (daemon descriptor, account boxes,
    // registry, platform) so the switcher agrees with My machines.
    const kindById = new Map<string, MachineKind>();
    // Names from the same fold: a box shows its Uno name, never the guest hostname.
    const labelById = new Map<string, string>();
    for (const row of machineRows) {
      if (row.environmentId) {
        kindById.set(row.environmentId, row.kind);
        labelById.set(row.environmentId, row.label);
      }
    }

    const primary: SwitcherMachine[] = primaryDescriptor
      ? [
          {
            id: primaryDescriptor.environmentId,
            // A cloud computer is called by its own name (the registry may still
            // hold a generic "This machine" from older versions).
            name: isElectron
              ? localComputerName(primaryDescriptor.platform.os)
              : primaryDescriptor.machineKind === "uno_box" && primaryDescriptor.label
                ? primaryDescriptor.label
                : (labelById.get(primaryDescriptor.environmentId) ?? primaryDescriptor.label),
            meta: formatPlatformMeta(
              primaryDescriptor.platform.os,
              primaryDescriptor.platform.arch,
            ),
            kind:
              kindById.get(primaryDescriptor.environmentId) ??
              deriveMachineKind({ descriptor: primaryDescriptor }),
            connectionState: "connected",
            isPrimary: true,
            isDefault: explicitDefaultId === primaryDescriptor.environmentId,
          },
        ]
      : [];

    const saved = Object.values(savedEnvironmentRegistry)
      .filter((record) => record.environmentId !== primaryDescriptor?.environmentId)
      .map((record): SwitcherMachine => {
        const runtime = savedEnvironmentRuntimeById[record.environmentId];
        const descriptor = runtime?.descriptor;
        const details = descriptor
          ? formatPlatformMeta(descriptor.platform.os, descriptor.platform.arch)
          : formatSavedEnvironmentMeta({
              httpBaseUrl: record.httpBaseUrl,
              ...(record.desktopSsh?.alias
                ? {
                    desktopSshAlias: record.desktopSsh.alias,
                  }
                : {}),
            });
        const connectionState = runtime?.connectionState ?? "disconnected";
        return {
          id: record.environmentId,
          name: labelById.get(record.environmentId) ?? descriptor?.label ?? record.label,
          meta: formatSavedEnvironmentStatusMeta({
            connectionState,
            lastSynchronizedAt: runtime?.lastSynchronizedAt ?? null,
            details,
          }),
          kind: kindById.get(record.environmentId) ?? deriveMachineKind({ descriptor }),
          connectionState,
          isPrimary: false,
          isDefault: explicitDefaultId === record.environmentId,
        };
      });

    return [...primary, ...saved];
  }, [
    explicitDefaultId,
    machineRows,
    primaryDescriptor,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);

  // Cloud computers on the account that this app hasn't connected to yet: one
  // click wakes, connects and opens them.
  const accountBoxes = useMemo(
    () =>
      machineRows.filter(
        (row) =>
          row.environmentId === null &&
          row.box !== null &&
          row.box.workMachine === true &&
          row.box.status !== "deleted",
      ),
    [machineRows],
  );

  const openMachine = (environmentId: EnvironmentId, kind: MachineKind) => {
    onDone?.();
    switchEnvironment(environmentId, kind === "uno_box" ? { landing: "computer" } : undefined);
  };

  const openAccountBox = async (row: (typeof accountBoxes)[number]) => {
    if (!primaryEnvironmentId || !row.box || connecting) return;
    setConnecting({ boxId: row.box.id, label: "Connecting…" });
    try {
      const record = await connectUnoBox(primaryEnvironmentId, row.box, {
        onProgress: (progress) =>
          setConnecting({ boxId: row.box!.id, label: describeUnoBoxConnectProgress(progress) }),
      });
      onDone?.();
      switchEnvironment(record.environmentId, { landing: "computer" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Couldn't open ${row.label}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setConnecting(null);
    }
  };

  const currentId = activeEnvironmentId ?? primaryEnvironmentId ?? environments[0]?.id ?? null;
  const current =
    environments.find((environment) => environment.id === currentId) ??
    (currentId
      ? {
          id: currentId,
          ...FALLBACK_ENV,
        }
      : null);
  const groups = useMemo(() => groupSwitcherMachines(environments), [environments]);

  const currentSavedEnvironment = current ? savedEnvironmentRegistry[current.id] : null;
  const canReconnectCurrent =
    currentSavedEnvironment != null &&
    (current?.connectionState === "disconnected" || current?.connectionState === "error");
  const isReconnectingCurrent = current != null && reconnectingId === current.id;

  const reconnectCurrentEnvironment = () => {
    if (!currentSavedEnvironment || !current) return;
    void reconnect(current.id);
  };

  const toggleDefault = (environmentId: EnvironmentId) => {
    setDefaultEnvironment(explicitDefaultId === environmentId ? null : environmentId);
  };

  return {
    environments,
    groups,
    current,
    currentId,
    accountBoxes,
    connecting,
    openMachine,
    openAccountBox,
    toggleDefault,
    canReconnectCurrent,
    isReconnectingCurrent,
    reconnectCurrentEnvironment,
    unlinkedLocalDaemon,
    useThisComputer,
    addEnvOpen,
    setAddEnvOpen,
    openAddComputer: () => {
      onDone?.();
      setAddEnvOpen(true);
    },
    goAllComputers: () => {
      onDone?.();
      void navigate({ to: "/my-uno" });
    },
  };
}

export type ComputerSwitcher = ReturnType<typeof useComputerSwitcher>;
