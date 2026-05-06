import {
  CheckIcon,
  ChevronsUpDownIcon,
  CloudIcon,
  GlobeIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, EnvironmentConnectionState } from "@t3tools/contracts";

import { AddEnvModal } from "./AddEnvModal";
import { cn } from "../lib/utils";
import { readPrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import {
  reconnectSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { selectSidebarThreadsForEnvironment, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface EnvironmentOption {
  id: EnvironmentId;
  name: string;
  meta: string;
  kind: "local" | "uno" | "custom";
  connectionState: EnvironmentConnectionState;
}

const FALLBACK_ENV = {
  name: "This device",
  meta: "Starting...",
  kind: "local",
  connectionState: "connecting",
} as const satisfies Omit<EnvironmentOption, "id">;

const KIND_ICON: Record<EnvironmentOption["kind"], typeof MonitorIcon> = {
  local: MonitorIcon,
  uno: CloudIcon,
  custom: GlobeIcon,
};

const GROUP_LABELS: Record<EnvironmentOption["kind"], string> = {
  local: "Local",
  uno: "Uno VPS",
  custom: "Custom",
};

const STATUS_DOT_CLASS: Record<EnvironmentConnectionState, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
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
    return fallback.length > 0 ? fallback : "Saved environment";
  }
}

export function SidebarEnvSwitcher() {
  const navigate = useNavigate();
  const [addEnvOpen, setAddEnvOpen] = useState(false);
  const [reconnectingEnvironmentId, setReconnectingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);

  const environments = useMemo<EnvironmentOption[]>(() => {
    const primaryDescriptor = readPrimaryEnvironmentDescriptor();
    const primary = primaryDescriptor
      ? [
          {
            id: primaryDescriptor.environmentId,
            name: primaryDescriptor.label,
            meta: formatPlatformMeta(
              primaryDescriptor.platform.os,
              primaryDescriptor.platform.arch,
            ),
            kind: "local" as const,
            connectionState: "connected" as const,
          },
        ]
      : [];

    const saved = Object.values(savedEnvironmentRegistry)
      .filter((record) => record.environmentId !== primaryDescriptor?.environmentId)
      .toSorted((left, right) => left.label.localeCompare(right.label))
      .map((record) => {
        const runtime = savedEnvironmentRuntimeById[record.environmentId];
        const descriptor = runtime?.descriptor;
        return {
          id: record.environmentId,
          name: descriptor?.label ?? record.label,
          meta: descriptor
            ? formatPlatformMeta(descriptor.platform.os, descriptor.platform.arch)
            : formatSavedEnvironmentMeta({
                httpBaseUrl: record.httpBaseUrl,
                ...(record.desktopSsh?.alias
                  ? {
                      desktopSshAlias: record.desktopSsh.alias,
                    }
                  : {}),
              }),
          kind: "custom" as const,
          connectionState: runtime?.connectionState ?? "disconnected",
        };
      });

    return [...primary, ...saved];
  }, [savedEnvironmentRegistry, savedEnvironmentRuntimeById]);

  const currentId = activeEnvironmentId ?? primaryEnvironmentId ?? environments[0]?.id ?? null;
  const current =
    environments.find((environment) => environment.id === currentId) ??
    (currentId
      ? {
          id: currentId,
          ...FALLBACK_ENV,
        }
      : null);
  const groups = (Object.keys(GROUP_LABELS) as EnvironmentOption["kind"][])
    .map((kind) => ({
      kind,
      items: environments.filter((environment) => environment.kind === kind),
    }))
    .filter((g) => g.items.length > 0);

  const CurrentIcon = current ? KIND_ICON[current.kind] : MonitorIcon;
  const currentSavedEnvironment = current ? savedEnvironmentRegistry[current.id] : null;
  const canReconnectCurrent =
    currentSavedEnvironment != null &&
    (current?.connectionState === "disconnected" || current?.connectionState === "error");
  const isReconnectingCurrent = current != null && reconnectingEnvironmentId === current.id;

  const switchEnvironment = (environmentId: EnvironmentId) => {
    setActiveEnvironmentId(environmentId);
    const firstThread = selectSidebarThreadsForEnvironment(useStore.getState(), environmentId).find(
      (thread) => thread.archivedAt === null,
    );
    if (firstThread) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId,
          threadId: firstThread.id,
        }),
      });
      return;
    }
    void navigate({ to: "/" });
  };

  const reconnectCurrentEnvironment = async () => {
    if (!currentSavedEnvironment || !current) return;
    setReconnectingEnvironmentId(current.id);
    try {
      await reconnectSavedEnvironment(current.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reconnect environment.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect environment",
          description: message,
        }),
      );
    } finally {
      setReconnectingEnvironmentId(null);
    }
  };

  return (
    <>
      <div className="flex w-full items-stretch gap-1">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left transition-colors hover:bg-accent"
                aria-label="Switch environment"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    current ? STATUS_DOT_CLASS[current.connectionState] : "bg-muted-foreground/40",
                  )}
                />
                <CurrentIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {current?.name ?? "No environment"}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {current?.meta ?? "Connect an environment"}
                  </div>
                </div>
                <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
              </button>
            }
          />
          <MenuPopup align="start" side="top" sideOffset={6} className="min-w-[15rem] p-1">
            {groups.map((group) => (
              <div key={group.kind} className="flex flex-col">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {GROUP_LABELS[group.kind]}
                </div>
                {group.items.map((env) => {
                  const Icon = KIND_ICON[env.kind];
                  const isActive = env.id === currentId;
                  return (
                    <button
                      key={env.id}
                      type="button"
                      onClick={() => switchEnvironment(env.id)}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                        isActive && "bg-accent/60",
                      )}
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
                        <div className="truncate font-medium">{env.name}</div>
                        <div className="truncate text-[10px] text-muted-foreground">{env.meta}</div>
                      </div>
                      {isActive ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {groups.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                No environments connected
              </div>
            ) : null}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              onClick={() => setAddEnvOpen(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/8"
            >
              <PlusIcon className="size-3.5" />
              <span>Add new environment</span>
            </button>
          </MenuPopup>
        </Menu>
        {canReconnectCurrent ? (
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isReconnectingCurrent}
            title="Reconnect environment"
            aria-label="Reconnect environment"
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
