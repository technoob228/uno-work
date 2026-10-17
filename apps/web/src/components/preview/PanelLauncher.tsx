/**
 * The right panel's launcher (plan 22, step 1; w0138): what the panel shows
 * when it is open with nothing in it, and what "+" in the tab strip opens.
 * Tiles — Your site (always first: the person's site in this device's
 * browser, one Comment button for notes and errors), Agent's browser (the
 * chat computer's: the agent works there, the person signs in for it),
 * Files, Changes, Apps — each opening the thing that already exists (rules:
 * `panelLauncher.logic.ts`). A letter opens a tile while the launcher has
 * focus, like t3's empty right panel.
 *
 * Apps opens a list right here (← All goes back): the apps of every
 * computer and the person's sites; a pick opens as a tab beside the chat,
 * everything else about them stays on Apps & sites. With no apps the list
 * says how to get one.
 *
 * Behind the Labs flag `panelLauncherV2`; without it the panel shows the
 * launcher of 0.0.137 (`LegacyPanelLauncher.tsx`).
 */
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  DiffIcon,
  FolderIcon,
  GlobeIcon,
  LayoutGridIcon,
  LockIcon,
  MonitorPlayIcon,
  PuzzleIcon,
  SparklesIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { useComposerHandleContext } from "../../composerHandleContext";
import { demoHooks, useDemoDesktop } from "../../demo/demoFlag";
import { isElectron } from "../../env";
import {
  usePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../../environments/primary";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { useMachineLabels } from "../../hooks/useMachineRows";
import { cn } from "../../lib/utils";
import { ProgramIcon } from "../computer/ComputerPrograms";
import { siteRows } from "../sites/sitesModel";
import { useWorkSites } from "../sites/useWorkSites";
import { Skeleton } from "../ui/skeleton";
import { useChatPanelActions } from "./chatPanelActions";
import { LegacyPanelLauncher } from "./LegacyPanelLauncher";
import {
  APP_IDEAS,
  APP_STATE_LABEL,
  type LauncherAppRow,
  type LauncherTileId,
  isTypingTarget,
  launcherKeyLabel,
  launcherTileForKey,
  visibleLauncherTiles,
} from "./panelLauncher.logic";
import type { PluginPanelDescriptor } from "./PluginPanelChat";
import { makeAppFile, makePluginPanelFile, usePreviewPane } from "./PreviewPaneContext";
import { useChatBrowser } from "./useChatBrowser";
import { useLauncherApps } from "./useLauncherApps";

const TILE_ICON: Record<LauncherTileId, typeof GlobeIcon> = {
  site: GlobeIcon,
  agentBrowser: MonitorPlayIcon,
  files: FolderIcon,
  changes: DiffIcon,
  apps: LayoutGridIcon,
};

type LauncherView = "tiles" | "apps";

type PanelLauncherProps = Parameters<typeof LegacyPanelLauncher>[0];

export function PanelLauncher(props: PanelLauncherProps) {
  const v2 = useFeatureFlag("panelLauncherV2");
  return v2 ? <PanelLauncherV2 {...props} /> : <LegacyPanelLauncher {...props} />;
}

function PanelLauncherV2({
  panels,
  takeFocus,
  onFocusTaken,
  onOpenedTab,
  onOpenedElsewhere,
  onDismiss,
}: {
  /** Live plugin panels (PreviewPane already follows them). */
  panels: ReadonlyArray<PluginPanelDescriptor>;
  /** The person asked for the launcher just now: it takes the focus (letters work). */
  takeFocus: boolean;
  onFocusTaken: () => void;
  /** Something opened as a tab of this panel. */
  onOpenedTab: () => void;
  /** Something opened outside the panel (Changes). */
  onOpenedElsewhere: () => void;
  /** Escape. */
  onDismiss: () => void;
}) {
  const {
    currentChatEnvironmentId,
    currentChatProjectCwd,
    currentChatThreadId,
    openBrowser,
    openAppTab,
    openFile,
  } = usePreviewPane();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const pluginsEnabled = useFeatureFlag("plugins");
  const demoDesktop = useDemoDesktop();
  const desktop = isElectron || demoDesktop;
  const { sources, openInSource } = useChatBrowser();
  const chatActions = useChatPanelActions(currentChatThreadId);
  const machine = useActiveMachine();
  const machineLabels = useMachineLabels();
  const apps = useLauncherApps();
  const sitesQuery = useWorkSites(machine.environmentId);
  const composerRef = useComposerHandleContext();
  const [view, setView] = useState<LauncherView>("tiles");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!takeFocus) return;
    onFocusTaken();
    // After this frame's other focus moves (the composer refocuses itself on
    // some updates), not before them.
    const frame = window.requestAnimationFrame(() => {
      rootRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [takeFocus, onFocusTaken]);

  const panelList = pluginsEnabled ? panels : [];
  const sites = useMemo(
    () => (sitesQuery.data?.availability === "ok" ? siteRows(sitesQuery.data.sites) : []),
    [sitesQuery.data],
  );
  const environmentId = currentChatEnvironmentId ?? primaryEnvironmentId;
  const agentComputer =
    sources.includes("computer") && currentChatEnvironmentId
      ? (machineLabels.get(currentChatEnvironmentId) ?? "the chat's computer")
      : null;
  const deviceName = desktop
    ? primaryDescriptor?.platform.os === "darwin"
      ? "this Mac"
      : "this computer"
    : "your browser";
  const tiles = visibleLauncherTiles({
    agentBrowserOn: agentComputer,
    hasComputer: environmentId !== null,
    canOpenChanges: chatActions?.openChanges != null,
  });

  const open = (id: LauncherTileId): void => {
    switch (id) {
      case "site":
        // Always this device's browser in the panel — never the agent's, no
        // matter the chat's computer or any setting (Misha 16.10).
        openInSource("app");
        onOpenedTab();
        return;
      case "agentBrowser":
        openInSource("computer");
        onOpenedTab();
        return;
      case "files":
        // "Browse files" as before: pick a file, it opens as a tab.
        openBrowser({ environmentId, startPath: currentChatProjectCwd ?? null });
        return;
      case "changes":
        chatActions?.openChanges?.();
        onOpenedElsewhere();
        return;
      case "apps":
        setView("apps");
        return;
    }
  };

  // Letters work while the launcher is on screen and the person isn't typing
  // somewhere — right after clicking Panel too (focus on the button).
  const lettersRef = useRef({ tiles, open, view });
  lettersRef.current = { tiles, open, view };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = lettersRef.current;
      if (event.defaultPrevented || current.view !== "tiles") return;
      if (isTypingTarget(event.target instanceof HTMLElement ? event.target : null)) return;
      const id = launcherTileForKey(current.tiles, event);
      if (!id) return;
      event.preventDefault();
      current.open(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const openApp = (row: LauncherAppRow) => {
    if (!row.url) {
      void navigate({ to: "/sites", search: { tab: "apps" } });
      return;
    }
    openAppTab(makeAppFile({ url: row.url, name: row.name, icon: row.icon }));
    onOpenedTab();
  };
  const askForApp = (idea: string) => {
    const composer = composerRef?.current;
    if (composer?.attachFromPanel) {
      composer.attachFromPanel({ text: idea });
    } else {
      composer?.focusAtEnd();
    }
  };
  const nothingListed = !apps.loading && apps.rows.length === 0 && panelList.length === 0;
  // Couldn't ask any computer: say so rather than "no apps yet".
  const appsFailed = nothingListed && apps.failed;
  const noApps = nothingListed && !apps.failed;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="panel-launcher"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (view !== "tiles") setView("tiles");
          else onDismiss();
          event.preventDefault();
          return;
        }
      }}
      className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-4 outline-none"
    >
      {view === "tiles" ? (
        <>
          <div className="mb-3">
            <h3 className="text-[13px] font-semibold text-foreground">Open in the panel</h3>
            <p className="text-xs text-muted-foreground">Press a letter to open.</p>
          </div>
          <ul className="flex flex-col gap-px" data-testid="panel-launcher-list">
            {tiles.map((tile) => {
              const Icon = TILE_ICON[tile.id];
              const secondary = tile.id === "agentBrowser";
              const where =
                tile.id === "site"
                  ? desktop
                    ? `Opens on ${deviceName}. Turn on Comment to leave notes and see errors.`
                    : primaryEnvironmentId
                      ? // The web version (p.14): a live page of the computer's browser.
                        `Opens right here, in the browser of ${machineLabels.get(primaryEnvironmentId) ?? "your computer"}. Your sign-ins stay there.`
                      : "Opens in a new tab of your browser, with your own sign-ins."
                  : tile.id === "agentBrowser"
                    ? `Runs on ${agentComputer ?? "the chat's computer"}. The agent works there; your sign-ins stay on that computer.`
                    : undefined;
              return (
                <li
                  key={tile.id}
                  className={cn(
                    "list-none",
                    secondary && "mt-2 border-t border-border/60 pt-2 opacity-75 hover:opacity-100",
                  )}
                >
                  <button
                    type="button"
                    data-testid={`panel-launcher-${tile.id}`}
                    onClick={() => open(tile.id)}
                    title={where}
                    className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-foreground">
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {tile.name}
                      </span>
                      <span className="line-clamp-2 block text-xs text-muted-foreground">
                        {tile.description}
                      </span>
                    </span>
                    <kbd className="shrink-0 rounded border border-border px-1.5 font-sans text-[10.5px] text-muted-foreground">
                      {launcherKeyLabel(tile)}
                    </kbd>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setView("tiles")}
            className="mb-2 inline-flex w-fit cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            All
          </button>
          <SectionTitle>Apps</SectionTitle>
          {appsFailed ? (
            <p
              className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground"
              data-testid="panel-launcher-apps-failed"
            >
              Couldn't load the apps right now. They're on Apps &amp; sites.
            </p>
          ) : noApps ? (
            <div
              className="rounded-lg border border-dashed border-border px-3 py-3"
              data-testid="panel-launcher-apps-empty"
            >
              <p className="text-[13px] font-medium text-foreground">No apps yet</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Ask the agent to make one. It runs on your computer and opens here.
              </p>
              <div className="mt-2 flex flex-col gap-1">
                {APP_IDEAS.map((idea) => (
                  <button
                    key={idea}
                    type="button"
                    onClick={() => askForApp(idea)}
                    className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-foreground/85 hover:bg-accent"
                  >
                    <SparklesIcon className="size-3 shrink-0 text-muted-foreground" />
                    <span className="truncate">{idea}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ul className="flex flex-col gap-px" data-testid="panel-launcher-apps-list">
              {apps.loading
                ? [0, 1, 2].map((i) => (
                    <li key={i} className="list-none">
                      <Skeleton className="my-0.5 h-8 w-full rounded-md" />
                    </li>
                  ))
                : null}
              {apps.rows.map((row) => (
                <ListRow
                  key={row.key}
                  icon={
                    <ProgramIcon
                      name={row.name}
                      icon={row.icon}
                      iconImage={row.iconImage}
                      templateId={row.templateId}
                      className="size-6 rounded-md text-sm shadow-none"
                    />
                  }
                  title={row.name}
                  subtitle={row.computer}
                  afterTitle={<AppState state={row.state} />}
                  muted={row.url === null}
                  onClick={() => openApp(row)}
                />
              ))}
              {panelList.map((panel) => (
                <ListRow
                  key={panel.id}
                  icon={<PuzzleIcon className="size-4 text-muted-foreground" />}
                  title={panel.title}
                  subtitle="Panel"
                  onClick={() => {
                    openFile(makePluginPanelFile(panel.id, panel.title));
                    onOpenedTab();
                  }}
                />
              ))}
            </ul>
          )}
          {sites.length > 0 ? (
            <>
              <SectionTitle className="mt-4">Sites</SectionTitle>
              <ul className="flex flex-col gap-px" data-testid="panel-launcher-sites-list">
                {sites.map((site) => (
                  <ListRow
                    key={site.slug}
                    icon={
                      <span className="inline-flex size-6 items-center justify-center rounded-md bg-muted">
                        <GlobeIcon className="size-3.5 text-muted-foreground" />
                      </span>
                    }
                    title={site.host}
                    subtitle={site.madeIn ? `Made in “${site.madeIn.title}”` : "On Uno Hosting"}
                    afterTitle={
                      site.hasPassword ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <LockIcon className="size-3" />
                          Password
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">Live</span>
                      )
                    }
                    onClick={() => {
                      // The demo shows its own page for a site (outside it: undefined).
                      const mapUrl = demoHooks.siteOpenUrl as ((url: string) => string) | undefined;
                      openAppTab(
                        makeAppFile({ url: mapUrl?.(site.url) ?? site.url, name: site.host }),
                      );
                      onOpenedTab();
                    }}
                  />
                ))}
              </ul>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => void navigate({ to: "/sites", search: { tab: "apps" } })}
            className="mt-3 w-fit cursor-pointer text-xs text-primary hover:underline"
          >
            All apps &amp; sites
          </button>
        </>
      )}
    </div>
  );
}

function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={cn("mb-1 px-1.5 text-xs font-medium text-muted-foreground", className)}>
      {children}
    </h3>
  );
}

function AppState({ state }: { state: LauncherAppRow["state"] }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          state === "running" ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
      {APP_STATE_LABEL[state]}
    </span>
  );
}

function ListRow({
  icon,
  title,
  subtitle,
  afterTitle,
  muted = false,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string | null;
  /** Right after the name: the status ("Running", "Password"). */
  afterTitle?: ReactNode;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          muted && "opacity-70",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] text-foreground">{title}</span>
            {afterTitle}
          </span>
          {subtitle ? (
            <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
