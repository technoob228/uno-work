import {
  CheckIcon,
  ChevronsUpDownIcon,
  LaptopIcon,
  LayoutGridIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { EnvironmentId, EnvironmentConnectionState } from "@t3tools/contracts";

import { accountTransport } from "../account/unoAccount";
import { AddEnvModal } from "./AddEnvModal";
import { isElectron } from "../env";
import { connectUnoBox, describeUnoBoxConnectProgress } from "../unoBoxConnect";
import { toastManager } from "./ui/toast";
import { cn } from "../lib/utils";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useDefaultEnvironment } from "../hooks/useDefaultEnvironment";
import { useLocalDaemonDiscovery, useUseThisComputer } from "../hooks/useLocalDaemon";
import { useMachineRows } from "../hooks/useMachineRows";
import { useReconnectEnvironment } from "../hooks/useReconnectEnvironment";
import { useSwitchEnvironment } from "../hooks/useSwitchEnvironment";
import { deriveMachineKind, type MachineKind } from "../machineKind";
import { MACHINE_KIND_GROUP_LABELS, MACHINE_KIND_LABELS } from "../plainLanguage";
import { useStore } from "../store";
import { formatElapsedAgoLabel } from "../timestampFormat";
import { MACHINE_KIND_ICON } from "./machineKindIcons";
import { groupSwitcherMachines, type SwitcherMachine } from "./SidebarEnvSwitcher.logic";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";

const FALLBACK_ENV = {
  name: "This machine",
  meta: "Starting...",
  kind: "server",
  connectionState: "connecting",
  isPrimary: true,
  isDefault: false,
} as const satisfies Omit<SwitcherMachine, "id">;

const STATUS_DOT_CLASS: Record<EnvironmentConnectionState, string> = {
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

/**
 * `card` is the two-line bordered block the legacy sidebar footer uses;
 * `compact` is a one-line ghost trigger that sits in the chat-list sidebar's
 * utility row next to the icon buttons.
 */
/** What the desktop app calls the computer it runs on. */
function localComputerName(os: string): string {
  return os === "darwin" ? "This Mac" : "This computer";
}

export function SidebarEnvSwitcher({
  variant = "card",
}: { variant?: "card" | "compact" | "header" } = {}) {
  const [addEnvOpen, setAddEnvOpen] = useState(false);
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
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
    setMenuOpen(false);
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
      setMenuOpen(false);
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

  const CurrentIcon = MACHINE_KIND_ICON[current?.kind ?? "server"];
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

  return (
    <>
      <div className="flex w-full items-stretch gap-1">
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-colors",
                  variant === "compact"
                    ? "h-8 px-2 text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
                    : variant === "header"
                      ? "h-11 px-2 hover:bg-sidebar-row-hover"
                      : "border border-border bg-background px-2 py-1.5 hover:bg-accent",
                )}
                aria-label="Switch computer"
                title={
                  variant === "compact" && current
                    ? `${current.name} · ${MACHINE_KIND_LABELS[current.kind]} · ${current.meta}`
                    : undefined
                }
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    current ? STATUS_DOT_CLASS[current.connectionState] : "bg-muted-foreground/40",
                  )}
                />
                <CurrentIcon className="size-3.5 shrink-0 text-muted-foreground" />
                {variant === "compact" ? (
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {current?.name ?? "No machine"}
                  </span>
                ) : variant === "header" ? (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {current?.name ?? "No computer"}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {current
                        ? current.isPrimary && isElectron
                          ? "On this computer"
                          : MACHINE_KIND_LABELS[current.kind]
                        : "Connect a computer"}
                    </div>
                  </div>
                ) : (
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground">
                      {current?.name ?? "No machine"}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {current
                        ? `${MACHINE_KIND_LABELS[current.kind]} · ${current.meta}`
                        : "Connect a machine"}
                    </div>
                  </div>
                )}
                <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
              </button>
            }
          />
          <MenuPopup
            align="start"
            side={variant === "header" ? "bottom" : "top"}
            sideOffset={6}
            className="min-w-[16rem] p-1"
          >
            {groups.map((group) => (
              <div key={group.kind} className="flex flex-col">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </div>
                {group.items.map((env) => {
                  const Icon = MACHINE_KIND_ICON[env.kind];
                  const isActive = env.id === currentId;
                  return (
                    <div
                      key={env.id}
                      className={cn(
                        "group/machine flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent",
                        isActive && "bg-accent/60",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => openMachine(env.id, env.kind)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            STATUS_DOT_CLASS[env.connectionState],
                          )}
                        />
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium">{env.name}</span>
                            {env.isDefault ? (
                              <span className="shrink-0 text-[10px] font-normal text-primary">
                                Default
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-[10px] text-muted-foreground">
                            {env.meta}
                          </div>
                        </div>
                        {isActive ? (
                          <CheckIcon className="size-3.5 shrink-0 text-primary" />
                        ) : env.isPrimary ? (
                          <span
                            className="shrink-0 text-[10px] text-muted-foreground"
                            title="The machine serving this page"
                          >
                            current
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleDefault(env.id)}
                        aria-pressed={env.isDefault}
                        aria-label={
                          env.isDefault
                            ? `Stop using ${env.name} as the default machine`
                            : `Make ${env.name} the default machine`
                        }
                        title={env.isDefault ? "Default machine" : "Make this the default machine"}
                        className={cn(
                          "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:text-foreground",
                          env.isDefault
                            ? "text-primary opacity-100"
                            : "opacity-0 focus-visible:opacity-100 group-hover/machine:opacity-100",
                        )}
                      >
                        <StarIcon
                          className={cn("size-3.5", env.isDefault && "fill-current")}
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
            {accountBoxes.length > 0 ? (
              <div className="flex flex-col">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {groups.some((group) => group.kind === "uno_box")
                    ? "More on your account"
                    : MACHINE_KIND_GROUP_LABELS.uno_box}
                </div>
                {accountBoxes.map((row) => {
                  const Icon = MACHINE_KIND_ICON.uno_box;
                  const busy = connecting?.boxId === row.box?.id;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      disabled={connecting !== null}
                      onClick={() => void openAccountBox(row)}
                      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-70"
                    >
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
                      />
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{row.label}</div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {busy && connecting ? connecting.label : row.detail || "Click to open"}
                        </div>
                      </div>
                      {busy ? (
                        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {groups.length === 0 && accountBoxes.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                No computers connected yet
              </div>
            ) : null}
            <div className="my-1 h-px bg-border" />
            {unlinkedLocalDaemon ? (
              <button
                type="button"
                disabled={useThisComputer.isBusy}
                onClick={() => void useThisComputer.run(unlinkedLocalDaemon)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/8 disabled:cursor-wait disabled:opacity-60"
              >
                <LaptopIcon className="size-3.5" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {useThisComputer.phase.kind === "waiting-for-approval"
                      ? "Waiting for Allow on this computer…"
                      : useThisComputer.phase.kind === "linking"
                        ? "Connecting this computer…"
                        : "Use this computer"}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {unlinkedLocalDaemon.label} · Uno Work is running here
                  </div>
                </div>
              </button>
            ) : null}
            {accountTransport() !== "none" ? (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void navigate({ to: "/my-uno" });
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              >
                <LayoutGridIcon className="size-3.5 text-muted-foreground" />
                <span>All computers, sites and plan</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setAddEnvOpen(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/8"
            >
              <PlusIcon className="size-3.5" />
              <span>Add computer</span>
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
            onClick={() => void reconnectCurrentEnvironment()}
          >
            <RefreshCwIcon className={cn("size-3.5", isReconnectingCurrent && "animate-spin")} />
          </button>
        ) : null}
      </div>
      <AddEnvModal open={addEnvOpen} onOpenChange={setAddEnvOpen} />
    </>
  );
}
