/**
 * Home (`/computer`) — the start screen of the user's computer in Uno Work.
 *
 * Start work first: a greeting, the composer (a task typed here starts a chat
 * that sends it), what needs the person, "Continue", and widgets they arrange
 * (files, apps, recent chats…; see `home/`). The computer itself is one pill in
 * the header — on or asleep, how busy, Boost, Memory / cores, Sleep — and
 * "What's using my computer" (`?look=`) holds the live drill-down, what the
 * computer's apps wrote lately and the "For engineers" door.
 *
 * The apps: Uno, Files, Terminal, the App Store, then everything on the
 * computer — apps installed from the store, apps the person or Uno made
 * (registered in `~/.uno/apps`), and whatever the daemon found running: a VPN
 * in docker, a service, a web page on a port.
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
import { Link, getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { HardDriveIcon, HouseIcon, LayoutGridIcon, MonitorIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { accountTransport } from "../../account/unoAccount";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useOpenApp } from "../../navigation/useOpenApp";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { AppCatalogDialog } from "./AppCatalogDialog";
import { BoostControl } from "./BoostControl";
import { ChatInFolderDialog } from "./ChatInFolderDialog";
import { ComputerActivityCard } from "./ComputerActivityCard";
import { ComputerEngineersDoor } from "./ComputerEngineersDoor";
import { ComputerCloudStorageRow } from "./ComputerCloudStorageRow";
import { ComputerHero, PowerConfirmDialog, type ComputerLoad } from "./ComputerHero";
import { ComputerPrograms, type BuiltInPrograms } from "./ComputerPrograms";
import { awakeLine, computerPowerState, humanDuration, sizeLine } from "./computerFormat";
import {
  appAiQueryKey,
  appAiQueryOptions,
  appAiUpdate,
  appSignInApi,
  computerActivityQueryOptions,
  computerAppsQueryOptions,
  computerMetricsQueryOptions,
  computerPowerMutationOptions,
  computerQueryKeys,
  computerStateQueryOptions,
  localMetricsQueryOptions,
  machineAppActionMutationOptions,
  machineAppsQueryOptions,
  removeStoreAppMutationOptions,
  setAppAiLimitMutationOptions,
} from "./computerQueries";
import { ProgramDialog, type ProgramRemoveControls } from "./ProgramDialog";
import { openAppSignedIn } from "./openSignedIn";
import { ComputerPill, type HomeComputer } from "./home/ComputerPill";
import { HomeStart, useHomeLayout } from "./home/HomeStart";
import { ResizeDialog } from "./ResizeDialog";
import { ResourcesView } from "./resources/ResourcesView";
import type { ResourceLook } from "./resources/resourceModel";
import { LOW_DISK_PCT, LOW_MEMORY_PCT, isSustained } from "./resizeModel";
import {
  buildProgramTiles,
  hiddenMachineApps,
  isBrowserOnMachine,
  removalCloudFiles,
  type ProgramTile,
} from "./programModel";
import { useAppInstalls } from "./useAppInstalls";
import { useComputerBoost } from "./useComputerBoost";
import { useHomeLaunchers } from "./useHomeLaunchers";

const routeApi = getRouteApi("/_chat/computer");

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
  // Apps' cloud folders (Settings → Apps): only this machine's daemon knows them.
  const appAiQuery = useQuery({
    ...appAiQueryOptions(environmentId, thisMachine),
    // Read when the screen opens; Settings → Apps is the one that keeps polling.
    refetchInterval: false,
  });

  const powerMutation = useMutation(
    computerPowerMutationOptions(environmentId, pickedBoxId, queryClient),
  );
  const appAction = useMutation(machineAppActionMutationOptions(environmentId, queryClient));
  const removeStoreApp = useMutation(
    removeStoreAppMutationOptions(environmentId, pickedBoxId, queryClient),
  );
  const setAiLimit = useMutation(
    setAppAiLimitMutationOptions(environmentId, pickedBoxId, queryClient),
  );
  const signIn = appSignInApi(environmentId, pickedBoxId);
  const installs = useAppInstalls({
    environmentId,
    boxId: pickedBoxId,
    inFlight: appsQuery.data?.installed.apps ?? [],
  });
  const launchers = useHomeLaunchers(environmentId);

  const [storeOpen, setStoreOpen] = useState(false);
  const { openHere } = useOpenApp();
  const routeSearch = routeApi.useSearch();
  const navigate = useNavigate();
  const [folderOpen, setFolderOpen] = useState(false);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const [resizeOpen, setResizeOpen] = useState(false);
  const [powerConfirm, setPowerConfirm] = useState<"sleep" | "stop" | null>(null);
  const layout = useHomeLayout();

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
  const hasDriveApp = "/drive" in (router.routesByPath as unknown as Record<string, unknown>);
  const builtIns: BuiltInPrograms = {
    onNewChat: () => void launchers.newChat(),
    onChatInFolder: () => setFolderOpen(true),
    onFiles: hasFilesApp ? () => router.history.push("/files") : null,
    onDrive: hasDriveApp
      ? computer?.linked
        ? () => router.history.push("/drive")
        : null
      : undefined,
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

  const resetTileMutations = () => {
    appAction.reset();
    removeStoreApp.reset();
    setAiLimit.reset();
  };

  const deleteAppCloudFiles = (appId: string, name: string) => {
    appAiUpdate(environmentId, { appId, deleteCloudFiles: true })
      .then((overview) => {
        queryClient.setQueryData(appAiQueryKey(environmentId), overview);
        toastManager.add({ type: "success", title: `Deleted ${name}'s files in the cloud` });
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: `${name} is removed, but its cloud files are still there`,
          description: `${
            error instanceof Error ? error.message : String(error)
          } You can delete them in Files → Cloud storage → apps.`,
        }),
      );
  };

  const removingContainer = appAction.isPending && appAction.variables?.action === "remove";
  const remove: ProgramRemoveControls = {
    pending: removeStoreApp.isPending || removingContainer,
    error:
      removeStoreApp.error instanceof Error
        ? removeStoreApp.error.message
        : appAction.variables?.action === "remove" && appAction.error instanceof Error
          ? appAction.error.message
          : null,
    onReset: () => {
      removeStoreApp.reset();
      if (appAction.variables?.action === "remove") appAction.reset();
    },
    cloudFiles: (removal) =>
      thisMachine ? removalCloudFiles(removal, appAiQuery.data?.apps) : null,
    onRemove: (removal, deleteData, deleteCloudFiles, deleteCode) => {
      if (removal.kind === "store") {
        // Asked when the dialog opened; the app's id on this computer.
        const cloudFiles = deleteCloudFiles
          ? removalCloudFiles(removal, appAiQuery.data?.apps)
          : null;
        removeStoreApp.mutate(
          { deploymentId: removal.deploymentId, deleteData },
          {
            onSuccess: () => {
              installs.dismiss(removal.deploymentId);
              setDetailsKey(null);
              // After the app is gone, so it can't write new files meanwhile.
              if (cloudFiles) deleteAppCloudFiles(cloudFiles.appId, removal.name);
            },
          },
        );
        return;
      }
      if (removal.kind === "registered") {
        const cloudFiles = deleteCloudFiles
          ? removalCloudFiles(removal, appAiQuery.data?.apps)
          : null;
        const name = detailsTile?.name ?? removal.manifestId;
        appAction.mutate(
          { appId: removal.appId, action: "remove", ...(deleteCode ? { deleteCode: true } : {}) },
          {
            onSuccess: () => {
              setDetailsKey(null);
              toastManager.add({
                type: "success",
                title: `Removed ${name}`,
                ...(removal.codeDir && !deleteCode
                  ? { description: `Its code stays in ${removal.codeDir}.` }
                  : {}),
              });
              // After the app is stopped and its token withdrawn, so nothing writes meanwhile.
              if (cloudFiles) deleteAppCloudFiles(cloudFiles.appId, name);
              else void queryClient.invalidateQueries({ queryKey: appAiQueryKey(environmentId) });
            },
          },
        );
        return;
      }
      appAction.mutate(
        { appId: removal.appId, action: "remove" },
        { onSuccess: () => setDetailsKey(null) },
      );
    },
  };

  const openTile = (tile: ProgramTile) => {
    const store = tile.storeApp;
    if (tile.openUrl && store?.sso && store.deploymentId !== null) {
      // Sign in with Uno: the app opens already signed in, in its own tab —
      // the Uno sign-in cookie can't work inside Uno Work's cross-site frame.
      const deploymentId = store.deploymentId;
      void openAppSignedIn(() => signIn.openLink(deploymentId), tile.openUrl);
      return;
    }
    // Other apps open inside Uno Work; the app bar has "New tab" for the rest.
    if (tile.openUrl) {
      openHere({ url: tile.openUrl, name: tile.name, icon: tile.icon });
      return;
    }
    resetTileMutations();
    setDetailsKey(tile.key);
  };

  // The sidebar's "App Store" row lands here with ?store=1.
  const storeAvailable = builtIns.onAppStore !== null;
  useEffect(() => {
    if (routeSearch.store !== "1" || !storeAvailable) return;
    setStoreOpen(true);
    void navigate({ to: "/computer", search: {}, replace: true });
  }, [navigate, routeSearch.store, storeAvailable]);

  // "What's using your computer": this machine's own daemon reads it.
  const look = thisMachine ? routeSearch.look : undefined;
  const openLook = (next: ResourceLook, replace = false) =>
    void navigate({ to: "/computer", search: { look: next }, replace });
  const boostControls = useComputerBoost({
    environmentId,
    boxId: pickedBoxId,
    boost: computer?.linked ? box?.boost : undefined,
    stateUpdatedAt: stateQuery.dataUpdatedAt,
  });
  // Resizing a boosted computer would fight the boost: one at a time.
  const boosting = boostControls !== null && boostControls.state !== "off";
  const canResize = box !== null && computer?.linked === true && !boosting;
  const boostNode =
    boostControls && (power === "on" || boosting) ? (
      <BoostControl controls={boostControls} />
    ) : null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: computerQueryKeys.all });
  };

  const powerControls = box
    ? {
        pendingAction: powerMutation.isPending ? (powerMutation.variables?.action ?? null) : null,
        error: powerMutation.error instanceof Error ? powerMutation.error.message : null,
      }
    : null;
  // Home's header pill (and the "This computer" widget): the hero, folded.
  const homeComputer: HomeComputer | null =
    stateQuery.isPending || stateQuery.isError
      ? null
      : {
          name: heroName,
          subtitle: heroSubtitle,
          status: box?.status ?? null,
          address: box?.address ?? null,
          load,
          boosted: boosting,
          boost: boostControls ? <BoostControl controls={boostControls} size="xs" /> : null,
          onResize: canResize ? () => setResizeOpen(true) : undefined,
          power: powerControls
            ? {
                ...powerControls,
                onPower: (action) =>
                  action === "sleep" || action === "stop"
                    ? setPowerConfirm(action)
                    : powerMutation.mutate({ action }),
              }
            : null,
          onOpenLook: thisMachine ? (next) => openLook(next) : undefined,
          onAllComputers:
            accountTransport() !== "none" ? () => void navigate({ to: "/my-uno" }) : undefined,
          lowResource: box ? lowResource : null,
        };
  const pill = <ComputerPill computer={homeComputer} loading={stateQuery.isPending} />;

  const notices = (
    <>
      {stateQuery.isError ? (
        <Notice title="This screen can't reach your computer right now">
          {stateQuery.error instanceof Error ? stateQuery.error.message : null} It will try again by
          itself.
        </Notice>
      ) : null}
      {stateQuery.isSuccess && !computer?.linked ? <UnlinkedNote /> : null}
      {stateQuery.isSuccess && box === null && (computer?.candidates.length ?? 0) > 0 ? (
        <CloudComputers
          candidates={computer?.candidates ?? []}
          onPick={(id) => setPickedBoxId(id)}
        />
      ) : null}
    </>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex min-h-8 items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            {thisMachine ? (
              <>
                <HouseIcon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">Home</span>
                <div className="ml-auto flex min-w-0 items-center gap-1.5">{pill}</div>
              </>
            ) : (
              <>
                <MonitorIcon className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">This computer</span>
                <Button size="xs" variant="ghost" onClick={() => setPickedBoxId(null)}>
                  Back to this machine
                </Button>
                <div className="ml-auto flex items-center gap-1">
                  {accountTransport() !== "none" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      render={<Link to="/my-uno" />}
                      data-testid="home-my-uno"
                    >
                      <LayoutGridIcon className="size-3.5" />
                      All my computers
                    </Button>
                  ) : null}
                  <Button size="xs" variant="ghost" onClick={refresh} aria-label="Refresh">
                    <RefreshCwIcon className="size-3.5" />
                  </Button>
                </div>
              </>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {look ? (
            <ResourcesView
              environmentId={environmentId}
              look={look}
              onLookChange={(next) => openLook(next, true)}
              onBack={() => void navigate({ to: "/computer", search: {} })}
              onResize={canResize ? () => setResizeOpen(true) : undefined}
              onAskUno={launchers.askUno}
              boost={boostNode}
              footer={
                box ? (
                  <>
                    <ComputerActivityCard
                      activity={activityQuery.data}
                      loading={activityQuery.isPending}
                    />
                    <ComputerEngineersDoor box={box} />
                  </>
                ) : null
              }
            />
          ) : thisMachine ? (
            <HomeStart
              environmentId={environmentId}
              layout={layout}
              computer={homeComputer}
              notices={notices}
              builtIns={builtIns}
              tiles={tiles}
              machineApps={machineAppsQuery.data?.apps ?? []}
              appsLoading={machineAppsQuery.isPending}
              onOpenTile={openTile}
              onTileDetails={(tile) => {
                resetTileMutations();
                setDetailsKey(tile.key);
              }}
              hiddenApps={hiddenMachineApps(machineAppsQuery.data?.apps ?? [])}
              unhidingId={
                appAction.isPending && appAction.variables?.action === "unhide"
                  ? appAction.variables.appId
                  : null
              }
              onUnhide={(appId) => appAction.mutate({ appId, action: "unhide" })}
              onStartTask={launchers.startTask}
              onAskUno={launchers.askUno}
            />
          ) : (
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
                  {/* Another cloud computer, picked from a laptop: its full view. */}
                  <ComputerHero
                    name={heroName}
                    subtitle={heroSubtitle}
                    status={box?.status ?? null}
                    address={box?.address ?? null}
                    own={computer?.own ?? false}
                    load={load}
                    loadLive={cloudMetricsQuery.isSuccess}
                    power={
                      powerControls
                        ? {
                            ...powerControls,
                            onPower: (action) => powerMutation.mutate({ action }),
                          }
                        : null
                    }
                    onResize={canResize ? () => setResizeOpen(true) : undefined}
                    lowResource={box ? lowResource : null}
                    boost={boostNode}
                  />
                  <ComputerPrograms
                    builtIns={builtIns}
                    showBuiltIns={false}
                    tiles={tiles}
                    machineApps={undefined}
                    loading={false}
                    onOpenTile={openTile}
                    onTileDetails={(tile) => {
                      resetTileMutations();
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
          )}
        </div>
      </div>

      <PowerConfirmDialog
        confirm={powerConfirm}
        own={computer?.own ?? false}
        onCancel={() => setPowerConfirm(null)}
        onConfirm={(action) => {
          powerMutation.mutate({ action });
          setPowerConfirm(null);
        }}
      />

      <ProgramDialog
        tile={detailsTile}
        machineApps={machineAppsQuery.data}
        browserOnMachine={browserOnMachine}
        pendingAction={
          appAction.isPending
            ? (appAction.variables?.action ?? null)
            : (null as UnoMachineAppAction | null)
        }
        actionError={
          appAction.error instanceof Error && appAction.variables?.action !== "remove"
            ? appAction.error.message
            : null
        }
        onAction={(appId, action) =>
          appAction.mutate(
            { appId, action },
            // Hidden: it leaves the home screen, and its details with it.
            action === "hide" ? { onSuccess: () => setDetailsKey(null) } : undefined,
          )
        }
        onClose={() => setDetailsKey(null)}
        remove={remove}
        aiLimit={{
          pending: setAiLimit.isPending,
          error: setAiLimit.error instanceof Error ? setAiLimit.error.message : null,
          onSave: (deploymentId, limitUsd) => setAiLimit.mutateAsync({ deploymentId, limitUsd }),
        }}
        signIn={{
          open: (deploymentId, fallbackUrl) =>
            void openAppSignedIn(() => signIn.openLink(deploymentId), fallbackUrl),
          access: signIn.access,
          share: (deploymentId, login) =>
            signIn.share(deploymentId, login).then((r) => {
              void queryClient.invalidateQueries({
                queryKey: computerQueryKeys.apps(environmentId, pickedBoxId),
              });
              return r;
            }),
          unshare: (deploymentId, userId) =>
            signIn.unshare(deploymentId, userId).then((r) => {
              void queryClient.invalidateQueries({
                queryKey: computerQueryKeys.apps(environmentId, pickedBoxId),
              });
              return r;
            }),
        }}
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
          if (!open) {
            installs.clearStartError();
            installs.clearConfirm();
          }
        }}
        templates={catalog?.templates ?? []}
        categories={catalog?.categories ?? []}
        // The machine's size (what the console compares against), else what it reports.
        memTotalMb={box?.ramMb || load?.memTotalMb || null}
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
        onInstall={async (template, settings, options) => {
          if (await installs.install(template, settings, options)) setStoreOpen(false);
        }}
        confirm={installs.confirm}
        onCancelConfirm={installs.clearConfirm}
        builtInApps={
          builtIns.onDrive
            ? [
                {
                  id: "uno-drive",
                  name: "Uno Drive",
                  tagline:
                    "Your Cloud storage: find, share and open files from any computer. Send files to the Uno bot in Telegram — they land here, even while your computer sleeps.",
                  icon: (
                    <span className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 to-indigo-600 text-white">
                      <HardDriveIcon className="size-6" />
                    </span>
                  ),
                  onOpen: builtIns.onDrive,
                },
              ]
            : []
        }
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

function UnlinkedNote() {
  return (
    <p className="text-xs text-muted-foreground">
      This computer has no access to your Uno account right now, so it can't turn itself on and off
      or add apps. Give it access in{" "}
      <Link
        to="/settings/computer-access"
        className="text-primary underline-offset-4 hover:underline"
      >
        Settings → Computer access
      </Link>
      .
    </p>
  );
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
