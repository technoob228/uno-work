/**
 * The right panel's launcher (plan 22, step 1): what the panel shows when it
 * is open with nothing in it, and what "+" in the tab strip opens. Big tiles —
 * Browser, Files, Terminal, Changes, Apps, Sites — each opening the thing that
 * already exists (rules: `panelLauncher.logic.ts`). A letter opens a tile
 * while the launcher has focus, like t3's empty right panel.
 *
 * Apps and Sites open a short list right here (← All goes back); a pick opens
 * as a tab beside the chat, everything else about them stays on Apps & sites.
 *
 * This is the launcher of 0.0.137, kept as it was for the flag
 * `panelLauncherV2` off (the new one is `PanelLauncher.tsx`).
 */
import { useNavigate } from "@tanstack/react-router";
import {
  AppWindowIcon,
  ArrowLeftIcon,
  DiffIcon,
  FolderIcon,
  GlobeIcon,
  LayoutGridIcon,
  PanelsTopLeftIcon,
  PuzzleIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { cn } from "../../lib/utils";
import { appPrimaryAction } from "../computer/appPrimaryAction";
import { ProgramIcon } from "../computer/ComputerPrograms";
import { useProgramTiles } from "../computer/useProgramTiles";
import { siteRows } from "../sites/sitesModel";
import { useWorkSites } from "../sites/useWorkSites";
import { Skeleton } from "../ui/skeleton";
import { useChatPanelActions } from "./chatPanelActions";
import {
  type LegacyLauncherTileId as LauncherTileId,
  isTypingTarget,
  legacyLauncherTileForKey as launcherTileForKey,
  visibleLegacyLauncherTiles as visibleLauncherTiles,
} from "./panelLauncher.logic";
import type { PluginPanelDescriptor } from "./PluginPanelChat";
import { makeAppFile, makePluginPanelFile, usePreviewPane } from "./PreviewPaneContext";
import { useChatBrowser } from "./useChatBrowser";

const TILE_ICON: Record<LauncherTileId, typeof GlobeIcon> = {
  browser: GlobeIcon,
  files: FolderIcon,
  terminal: SquareTerminalIcon,
  changes: DiffIcon,
  apps: LayoutGridIcon,
  sites: PanelsTopLeftIcon,
};

type LauncherView = "tiles" | "apps" | "sites";

export function LegacyPanelLauncher({
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
  /** Something opened outside the panel (the terminal drawer, Changes). */
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
  const browserCompanionEnabled = useFeatureFlag("browserCompanion");
  const pluginsEnabled = useFeatureFlag("plugins");
  const { browsesOnMachine, openChatBrowser, openInSource } = useChatBrowser();
  const chatActions = useChatPanelActions(currentChatThreadId);
  const machine = useActiveMachine();
  const programs = useProgramTiles();
  const sitesQuery = useWorkSites(machine.environmentId);
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
  const openableApps = useMemo(
    () =>
      programs.tiles.flatMap((tile) => {
        const action = appPrimaryAction(tile);
        // A web app only the computer reaches opens in the computer's own browser.
        return (action.kind === "open" || action.kind === "openOnComputer") &&
          !action.disabled &&
          action.url
          ? [{ tile, url: action.url, onComputer: action.kind === "openOnComputer" }]
          : [];
      }),
    [programs.tiles],
  );
  const sites = useMemo(
    () => (sitesQuery.data?.availability === "ok" ? siteRows(sitesQuery.data.sites) : null),
    [sitesQuery.data],
  );
  const environmentId = currentChatEnvironmentId ?? primaryEnvironmentId;
  const tiles = visibleLauncherTiles({
    canBrowse: browserCompanionEnabled || browsesOnMachine,
    hasComputer: environmentId !== null,
    canOpenTerminal: chatActions?.openTerminal != null,
    canOpenChanges: chatActions?.openChanges != null,
    openableApps:
      machine.environmentId !== null && programs.loading
        ? null
        : openableApps.length + panelList.length,
    sites: sites?.length ?? null,
  });

  const open = (id: LauncherTileId): void => {
    switch (id) {
      case "browser":
        openChatBrowser();
        onOpenedTab();
        return;
      case "files":
        // "Browse files" as before: pick a file, it opens as a tab.
        openBrowser({ environmentId, startPath: currentChatProjectCwd ?? null });
        return;
      case "terminal":
        chatActions?.openTerminal?.();
        onOpenedElsewhere();
        return;
      case "changes":
        chatActions?.openChanges?.();
        onOpenedElsewhere();
        return;
      case "apps":
      case "sites":
        setView(id);
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
      className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-5 outline-none"
    >
      {view === "tiles" ? (
        <>
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-foreground">Open in the panel</h3>
            <p className="text-xs text-muted-foreground">Press a letter to open.</p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2.5">
            {tiles.map((tile) => {
              const Icon = TILE_ICON[tile.id];
              return (
                <button
                  key={tile.id}
                  type="button"
                  data-testid={`panel-launcher-${tile.id}`}
                  onClick={() => open(tile.id)}
                  className="flex min-h-26 cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-3.5 text-left outline-none transition-colors hover:border-primary/45 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex items-center gap-2">
                    <span className="inline-flex size-8 items-center justify-center rounded-lg bg-muted text-foreground">
                      <Icon className="size-4" />
                    </span>
                    <span className="text-sm font-semibold text-foreground">{tile.name}</span>
                    <kbd className="ml-auto rounded border border-border px-1.5 font-sans text-[10.5px] text-muted-foreground">
                      {tile.key}
                    </kbd>
                  </span>
                  <span className="text-xs leading-snug text-muted-foreground">
                    {tile.description}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setView("tiles")}
            className="mb-3 inline-flex w-fit cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowLeftIcon className="size-3.5" />
            All
          </button>
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            {view === "apps" ? "Apps" : "Sites"}
          </h3>
          <ul className="flex flex-col gap-px">
            {view === "apps" ? (
              <>
                {programs.loading && openableApps.length === 0 && machine.environmentId !== null
                  ? [0, 1, 2].map((i) => (
                      <li key={i} className="list-none">
                        <Skeleton className="my-0.5 h-8 w-full rounded-md" />
                      </li>
                    ))
                  : null}
                {openableApps.map(({ tile, url, onComputer }) => (
                  <ListRow
                    key={tile.key}
                    icon={
                      <ProgramIcon
                        name={tile.name}
                        icon={tile.icon}
                        iconImage={tile.iconImage}
                        templateId={tile.templateId ?? null}
                        className="size-6 rounded-md text-sm shadow-none"
                      />
                    }
                    title={tile.name}
                    subtitle={tile.product ?? tile.caption}
                    onClick={() => {
                      if (onComputer) openInSource("computer", url);
                      else openAppTab(makeAppFile({ url, name: tile.name, icon: tile.icon }));
                      onOpenedTab();
                    }}
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
              </>
            ) : (
              (sites ?? []).map((site) => (
                <ListRow
                  key={site.slug}
                  icon={<AppWindowIcon className="size-4 text-muted-foreground" />}
                  title={site.host}
                  subtitle={site.hasPassword ? "Opens with its password" : null}
                  onClick={() => {
                    openAppTab(makeAppFile({ url: site.url, name: site.host }));
                    onOpenedTab();
                  }}
                />
              ))
            )}
          </ul>
          <button
            type="button"
            onClick={() => void navigate({ to: "/sites", search: { tab: view } })}
            className="mt-3 w-fit cursor-pointer text-xs text-primary hover:underline"
          >
            All apps &amp; sites
          </button>
        </>
      )}
    </div>
  );
}

function ListRow({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string | null;
  onClick: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">{icon}</span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm text-foreground">{title}</span>
          {subtitle ? (
            <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
