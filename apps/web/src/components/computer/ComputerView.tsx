/**
 * "This computer" — the home screen of the user's computer in Uno Work.
 *
 * Desktop-like rather than admin-like: at the top, which computer this is,
 * whether it's on and how hard it's working (live CPU / memory / disk, read by
 * the daemon from its own OS). Below, the programs: Uno (a new chat, or a chat
 * in a folder), Files, Terminal, the App Store, then everything on the
 * computer — apps installed from the store, apps the person or Uno made
 * (registered in `~/.uno/apps`), and whatever the daemon found running: a VPN
 * in docker, a service, a web page on a port. Then what it's doing, and the
 * closed "For engineers" door.
 *
 * Everything goes through this environment's daemon (`uno.computer.*`); the
 * browser never holds the account key. Discovery and the launchers work even
 * without an Uno account — only the cloud parts (power, App Store, showing on
 * the internet) need one.
 *
 * On a laptop daemon the home screen is the laptop's own; the account's cloud
 * computers can be picked to look at, which shows that computer's cloud view.
 */
import type { UnoMachineAppAction } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { MonitorIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { AppCatalogDialog } from "./AppCatalogDialog";
import { ChatInFolderDialog } from "./ChatInFolderDialog";
import { ComputerActivityCard } from "./ComputerActivityCard";
import { ComputerEngineersDoor } from "./ComputerEngineersDoor";
import { ComputerCloudStorageRow } from "./ComputerCloudStorageRow";
import { ComputerHero, type ComputerLoad } from "./ComputerHero";
import { ComputerPrograms, type BuiltInPrograms } from "./ComputerPrograms";
import { awakeLine, computerPowerState, humanDuration, sizeLine } from "./computerFormat";
import {
  computerActivityQueryOptions,
  computerAppsQueryOptions,
  computerMetricsQueryOptions,
  computerPowerMutationOptions,
  computerQueryKeys,
  computerStateQueryOptions,
  localMetricsQueryOptions,
  machineAppActionMutationOptions,
  machineAppsQueryOptions,
} from "./computerQueries";
import { ProgramDialog } from "./ProgramDialog";
import { ResizeDialog } from "./ResizeDialog";
import { LOW_DISK_PCT, LOW_MEMORY_PCT, isSustained } from "./resizeModel";
import { buildProgramTiles, isBrowserOnMachine, type ProgramTile } from "./programModel";
import { useAppInstalls } from "./useAppInstalls";
import { useHomeLaunchers } from "./useHomeLaunchers";

const PLATFORM_WORD: Record<string, string> = {
  linux: "Linux",
  darwin: "Mac",
  win32: "Windows",
};

export function ComputerView() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const queryClient = useQueryClient();
  const router = useRouter();
  /** Only set when the daemon is not an Uno computer and the user picked one. */
  const [pickedBoxId, setPickedBoxId] = useState<number | null>(null);
  const thisMachine = pickedBoxId === null;

  const stateQuery = useQuery(computerStateQueryOptions(environmentId, pickedBoxId));
  const computer = stateQuery.data;
  const box = computer?.box ?? null;
  const power = computerPowerState(box?.status);
  const hasBox = box !== null;
  const computerOn = box ? power === "on" : true;

  const localMetricsQuery = useQuery(localMetricsQueryOptions(environmentId, thisMachine));
  const cloudMetricsQuery = useQuery(
    computerMetricsQueryOptions(environmentId, pickedBoxId, hasBox && !thisMachine),
  );
  const machineAppsQuery = useQuery(machineAppsQueryOptions(environmentId, thisMachine));
  const activityQuery = useQuery(computerActivityQueryOptions(environmentId, pickedBoxId, hasBox));
  const appsQuery = useQuery(computerAppsQueryOptions(environmentId, pickedBoxId, hasBox));

  const powerMutation = useMutation(
    computerPowerMutationOptions(environmentId, pickedBoxId, queryClient),
  );
  const appAction = useMutation(machineAppActionMutationOptions(environmentId, queryClient));
  const installs = useAppInstalls({
    environmentId,
    boxId: pickedBoxId,
    inFlight: appsQuery.data?.installed.apps ?? [],
  });
  const launchers = useHomeLaunchers(environmentId);

  const [storeOpen, setStoreOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const [resizeOpen, setResizeOpen] = useState(false);

  const browserOnMachine =
    thisMachine && typeof window !== "undefined" && isBrowserOnMachine(window.location.hostname);

  const tiles = useMemo(
    () =>
      buildProgramTiles({
        machineApps: thisMachine ? (machineAppsQuery.data?.apps ?? []) : [],
        storeApps: appsQuery.data?.installed.apps ?? [],
        installs: installs.installs,
        browserOnMachine,
        computerOn,
      }),
    [
      appsQuery.data,
      browserOnMachine,
      computerOn,
      installs.installs,
      machineAppsQuery.data,
      thisMachine,
    ],
  );
  const detailsTile = tiles.find((tile) => tile.key === detailsKey) ?? null;

  const load: ComputerLoad | null = thisMachine
    ? localMetricsQuery.data
      ? {
          cpuPct: localMetricsQuery.data.cpuPct,
          memUsedMb: localMetricsQuery.data.memUsedMb,
          memTotalMb: localMetricsQuery.data.memTotalMb,
          diskUsedGb: localMetricsQuery.data.diskUsedGb,
          diskTotalGb: localMetricsQuery.data.diskTotalGb,
        }
      : null
    : cloudMetricsQuery.data?.availability === "ok"
      ? {
          cpuPct: cloudMetricsQuery.data.cpuPct,
          memUsedMb: cloudMetricsQuery.data.memUsedMb,
          memTotalMb: cloudMetricsQuery.data.memLimitMb,
          diskUsedGb: cloudMetricsQuery.data.diskUsedGb,
          diskTotalGb: cloudMetricsQuery.data.diskTotalGb ?? box?.diskGb ?? null,
        }
      : null;

  const lowResource = useLowResource(load);

  const local = localMetricsQuery.data;
  const heroName = box?.name ?? local?.hostname ?? "This computer";
  const heroSubtitle = box
    ? [sizeLine(box), awakeLine(box)].filter(Boolean).join(" · ") ||
      "Your computer in the Uno cloud"
    : local
      ? `${PLATFORM_WORD[local.platform] ?? local.platform} · ${local.cpuCount} cores · awake ${humanDuration(local.uptimeS)}`
      : null;

  const catalog = appsQuery.data?.catalog;
  const hasFilesApp = "/files" in (router.routesByPath as unknown as Record<string, unknown>);
  const builtIns: BuiltInPrograms = {
    onNewChat: () => void launchers.newChat(),
    onChatInFolder: () => setFolderOpen(true),
    onFiles: hasFilesApp ? () => router.history.push("/files") : null,
    onTerminal: () => void launchers.openTerminal(),
    onAppStore:
      hasBox && catalog?.availability === "ok" && catalog.templates.length > 0
        ? () => setStoreOpen(true)
        : null,
    appStoreHint: !computer?.linked
      ? "Needs your Uno account"
      : !hasBox
        ? "On Uno computers"
        : catalog?.availability === "unavailable"
          ? "Coming soon"
          : null,
  };

  const openTile = (tile: ProgramTile) => {
    if (tile.openUrl) {
      window.open(tile.openUrl, "_blank", "noopener,noreferrer");
      return;
    }
    appAction.reset();
    setDetailsKey(tile.key);
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: computerQueryKeys.all });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <MonitorIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">This computer</span>
            {pickedBoxId !== null ? (
              <Button size="xs" variant="ghost" onClick={() => setPickedBoxId(null)}>
                Back to this machine
              </Button>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={refresh} aria-label="Refresh">
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
            {stateQuery.isPending ? (
              <>
                <Skeleton className="h-36 w-full rounded-3xl" />
                <Skeleton className="h-56 w-full rounded-2xl" />
              </>
            ) : stateQuery.isError ? (
              <Notice title="This screen can't reach your computer right now">
                {stateQuery.error instanceof Error ? stateQuery.error.message : null} It will try
                again by itself.
              </Notice>
            ) : (
              <>
                <ComputerHero
                  name={heroName}
                  subtitle={heroSubtitle}
                  status={box?.status ?? null}
                  address={box?.address ?? null}
                  own={computer?.own ?? false}
                  load={load}
                  loadLive={thisMachine ? localMetricsQuery.isSuccess : cloudMetricsQuery.isSuccess}
                  power={
                    box
                      ? {
                          pendingAction: powerMutation.isPending
                            ? (powerMutation.variables?.action ?? null)
                            : null,
                          error:
                            powerMutation.error instanceof Error
                              ? powerMutation.error.message
                              : null,
                          onPower: (action) => powerMutation.mutate({ action }),
                        }
                      : null
                  }
                  onResize={box && computer?.linked ? () => setResizeOpen(true) : undefined}
                  lowResource={box ? lowResource : null}
                />

                {!computer?.linked && thisMachine ? (
                  <p className="-mt-3 text-xs text-muted-foreground">
                    Add your Uno account key in{" "}
                    <Link
                      to="/settings"
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      Settings
                    </Link>{" "}
                    to turn this computer on and off, add apps from the App Store and show them on
                    the internet.
                  </p>
                ) : null}

                {thisMachine && box === null && (computer?.candidates.length ?? 0) > 0 ? (
                  <CloudComputers
                    candidates={computer?.candidates ?? []}
                    onPick={(id) => setPickedBoxId(id)}
                  />
                ) : null}

                <ComputerPrograms
                  builtIns={builtIns}
                  showBuiltIns={thisMachine}
                  tiles={tiles}
                  machineApps={thisMachine ? machineAppsQuery.data : undefined}
                  loading={thisMachine && machineAppsQuery.isPending}
                  onOpenTile={openTile}
                  onTileDetails={(tile) => {
                    appAction.reset();
                    setDetailsKey(tile.key);
                  }}
                />

                {box ? (
                  <>
                    <ComputerCloudStorageRow environmentId={environmentId} />
                    <ComputerActivityCard
                      activity={activityQuery.data}
                      loading={activityQuery.isPending}
                    />
                    <ComputerEngineersDoor box={box} />
                  </>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      <ProgramDialog
        tile={detailsTile}
        machineApps={machineAppsQuery.data}
        browserOnMachine={browserOnMachine}
        pendingAction={
          appAction.isPending
            ? (appAction.variables?.action ?? null)
            : (null as UnoMachineAppAction | null)
        }
        actionError={appAction.error instanceof Error ? appAction.error.message : null}
        onAction={(appId, action) => appAction.mutate({ appId, action })}
        onClose={() => setDetailsKey(null)}
      />

      <ResizeDialog
        environmentId={environmentId}
        boxId={pickedBoxId}
        open={resizeOpen}
        onOpenChange={setResizeOpen}
      />

      <ChatInFolderDialog
        environmentId={environmentId}
        open={folderOpen}
        onOpenChange={setFolderOpen}
        onStart={launchers.chatInFolder}
      />

      <AppCatalogDialog
        open={storeOpen}
        onOpenChange={(open) => {
          setStoreOpen(open);
          if (!open) installs.clearStartError();
        }}
        templates={catalog?.templates ?? []}
        installedTemplateIds={
          new Set(
            [
              ...installs.installs.map((i) => i.templateId),
              ...(appsQuery.data?.installed.apps ?? []).map((a) => a.templateId),
            ].filter((id): id is string => id !== null),
          )
        }
        starting={installs.starting}
        error={installs.startError}
        computerOn={computerOn}
        onInstall={async (template, settings) => {
          if (await installs.install(template, settings)) setStoreOpen(false);
        }}
      />
    </SidebarInset>
  );
}

/**
 * "Running low" only when it is steady: the last few readings (a few seconds
 * apart) all over the line — memory > 85 %, disk > 90 %.
 */
function useLowResource(load: ComputerLoad | null): "memory" | "disk" | null {
  const memory = useRef<number[]>([]);
  const disk = useRef<number[]>([]);
  const [low, setLow] = useState<"memory" | "disk" | null>(null);
  const memPct =
    load?.memUsedMb != null && load.memTotalMb ? (load.memUsedMb / load.memTotalMb) * 100 : null;
  const diskPct =
    load?.diskUsedGb != null && load.diskTotalGb
      ? (load.diskUsedGb / load.diskTotalGb) * 100
      : null;
  useEffect(() => {
    if (memPct !== null) memory.current = [...memory.current, memPct].slice(-10);
    if (diskPct !== null) disk.current = [...disk.current, diskPct].slice(-10);
    setLow(
      isSustained(memory.current, LOW_MEMORY_PCT)
        ? "memory"
        : isSustained(disk.current, LOW_DISK_PCT, 2)
          ? "disk"
          : null,
    );
  }, [memPct, diskPct]);
  return low;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-border/60 bg-card/40 p-7">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <MonitorIcon className="size-6" />
      </div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

function CloudComputers({
  candidates,
  onPick,
}: {
  candidates: ReadonlyArray<{ id: number; name: string; status: string }>;
  onPick: (boxId: number) => void;
}) {
  return (
    <div className="-mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Your Uno computers:</span>
      {candidates.map((candidate) => (
        <Button key={candidate.id} size="xs" variant="outline" onClick={() => onPick(candidate.id)}>
          <MonitorIcon />
          {candidate.name}
          <span className="text-muted-foreground">
            · {computerPowerState(candidate.status) === "on" ? "on" : candidate.status}
          </span>
        </Button>
      ))}
    </div>
  );
}
