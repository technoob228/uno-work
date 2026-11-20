/**
 * The Apps tab of Apps & sites, like Launchpad on a Mac (Misha 28.10: the
 * long list of rows "looked awful — just a few rows of icons, with search";
 * the grid: "совсем другое дело, отл"; moved onto 0.0.190).
 *
 * A search field on top, then one grid of big icons with the name under each:
 * Uno Drive, Uno Notetaker, Terminal and the App Store first, then the
 * person's apps. Typing keeps only the apps that match (`appsGridModel.ts`),
 * Enter opens the first one, Esc clears. A click does the app's one primary
 * action (Open — on whichever computer it is, Start, Fix with Uno…), a right
 * click or the ⚙ on hover opens its settings on Home, the pin on hover pins it
 * to the sidebar (the tile's own pin, as on Home). The port, the kind
 * ("App · 8471") and "On the internet" moved into the tooltip — under every
 * icon they were noise; a word stays under the name only when the app isn't
 * simply there to use ("Stopped").
 */
import { useNavigate } from "@tanstack/react-router";
import {
  HardDriveIcon,
  SearchIcon,
  ShoppingBagIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { usePins } from "../../navigation/usePins";
import { appPrimaryAction } from "../computer/appPrimaryAction";
import {
  BuiltInIcon,
  NotetakerBuiltInIcon,
  primaryActionTitle,
  ProgramIcon,
  TileShell,
} from "../computer/ComputerPrograms";
import { NotetakerConfirmDialog, useNotetakerApp } from "../computer/NotetakerBuiltIn";
import {
  isNotetakerTile,
  NOTETAKER_CAPTION,
  NOTETAKER_HINT,
  NOTETAKER_NAME,
} from "../computer/notetakerApp";
import type { ProgramTile } from "../computer/programModel";
import { useAppInstalls } from "../computer/useAppInstalls";
import { useAppPrimaryAction, useStartingAppId } from "../computer/useAppPrimaryAction";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import { useProgramTiles } from "../computer/useProgramTiles";
import { SidebarAppServers } from "../sidebar/SidebarAppServers";
import { useSidebar } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { filterAppsBySearch, firstToOpen } from "./appsGridModel";

interface BuiltIn {
  readonly key: string;
  readonly name: string;
  /** For the search and the tooltip; not shown under the icon. */
  readonly caption: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly run: () => void;
  /** A tile of its own (Uno Notetaker: Add, Installing…, its settings). */
  readonly tile?: ReactNode;
}

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(6.75rem,1fr))] gap-x-1 gap-y-2";

export function AppsGrid() {
  const { tiles, loading, hasStore, computer } = useProgramTiles();
  const machine = useActiveMachine();
  const launchers = useHomeLaunchers(machine.environmentId);
  const primary = useAppPrimaryAction({ environmentId: machine.environmentId });
  const startingId = useStartingAppId();
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const { isPinned, toggle } = usePins();
  const [query, setQuery] = useState("");
  const [terminalBusy, setTerminalBusy] = useState(false);

  const openSettings = (tile: ProgramTile) =>
    void navigate({ to: "/computer", search: { app: tile.key } });
  const runTile = (tile: ProgramTile) => {
    // Installing or asleep: the app's card on Home says why.
    if (appPrimaryAction(tile).disabled) {
      void navigate({ to: "/computer" });
      return;
    }
    primary.run(tile);
  };

  // Uno Notetaker stands among the built-ins, installed or not: not twice.
  // Its install poll runs only on this page.
  const inFlight = useMemo(
    () => tiles.flatMap((tile) => (tile.storeApp ? [tile.storeApp] : [])),
    [tiles],
  );
  const installs = useAppInstalls({ environmentId: machine.environmentId, boxId: null, inFlight });
  const notetaker = useNotetakerApp({
    installs,
    tiles,
    computer,
    onOpen: (tile) => primary.run(tile),
    onDetails: openSettings,
  });
  const ownTiles = tiles.filter((tile) => !isNotetakerTile(tile));

  const notetakerInstalled = notetaker.state.kind === "installed" ? notetaker.state.tile : null;
  const builtIns: BuiltIn[] = [
    {
      key: "drive",
      name: "Uno Drive",
      caption: "Cloud storage",
      icon: (
        <BuiltInIcon className="bg-gradient-to-br from-sky-400 to-indigo-600">
          <HardDriveIcon />
        </BuiltInIcon>
      ),
      run: () => void navigate({ to: "/drive" }),
    },
    {
      key: "notetaker",
      name: NOTETAKER_NAME,
      caption: NOTETAKER_HINT,
      icon: <NotetakerBuiltInIcon />,
      // Enter opens it once it is there; adding it stays a click on its tile.
      disabled: notetakerInstalled === null || notetaker.view.disabled,
      run: notetaker.onClick,
      tile: (
        <TileShell
          key="notetaker"
          label={NOTETAKER_NAME}
          // Only its news ("Coming soon", "Didn't install"), not "Meeting notes".
          caption={notetaker.view.caption === NOTETAKER_CAPTION ? null : notetaker.view.caption}
          {...(notetakerInstalled ? { status: notetakerInstalled.status } : {})}
          problem={notetaker.view.problem}
          title={notetaker.view.title}
          disabled={notetaker.view.disabled}
          chip={notetaker.view.chip}
          icon={<NotetakerBuiltInIcon />}
          onClick={notetaker.onClick}
          {...(notetaker.onDetails ? { onDetails: notetaker.onDetails } : {})}
        />
      ),
    },
    {
      key: "terminal",
      name: "Terminal",
      caption: "Command line",
      icon: (
        <BuiltInIcon className="bg-gradient-to-br from-zinc-700 to-zinc-900">
          <SquareTerminalIcon />
        </BuiltInIcon>
      ),
      disabled: terminalBusy,
      run: () => {
        setTerminalBusy(true);
        void launchers.openTerminal().finally(() => setTerminalBusy(false));
      },
    },
    ...(hasStore
      ? [
          {
            key: "store",
            name: "App Store",
            caption: "Add apps",
            icon: (
              <BuiltInIcon className="bg-gradient-to-br from-fuchsia-500 to-violet-600">
                <ShoppingBagIcon />
              </BuiltInIcon>
            ),
            run: () => void navigate({ to: "/computer", search: { store: "1" } }),
          },
        ]
      : []),
  ];

  const shownBuiltIns = filterAppsBySearch(builtIns, query);
  const shownTiles = filterAppsBySearch(ownTiles, query);
  const searching = query.trim() !== "";
  const nothingFound = searching && shownBuiltIns.length === 0 && shownTiles.length === 0;

  const openFirst = () => {
    const first = firstToOpen(shownBuiltIns, shownTiles, (tile) =>
      Boolean(appPrimaryAction(tile).disabled),
    );
    if (first === null) return;
    if ("builtIn" in first) first.builtIn.run();
    else runTile(first.tile);
  };

  return (
    <div className="flex flex-col gap-5" data-testid="apps-page">
      <label className="relative mx-auto flex w-full max-w-sm items-center">
        <SearchIcon className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
        <input
          type="search"
          value={query}
          // Like Launchpad: open the page and type. Not on a phone — the
          // keyboard would cover the icons.
          autoFocus={!isMobile}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              openFirst();
            } else if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              setQuery("");
            }
          }}
          placeholder="Search apps"
          aria-label="Search apps"
          data-testid="apps-search"
          className="h-9 w-full rounded-full border border-border bg-muted/40 pr-9 pl-9 text-sm outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query !== "" ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setQuery("")}
            className="absolute right-2 inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
      </label>

      {nothingFound ? (
        <p className="py-10 text-center text-sm text-muted-foreground" data-testid="apps-none">
          No apps called “{query.trim()}”
        </p>
      ) : (
        <ul className={GRID} aria-label="Apps" data-testid="apps-grid">
          {shownBuiltIns.map(
            (entry) =>
              entry.tile ?? (
                <TileShell
                  key={entry.key}
                  label={entry.name}
                  caption={null}
                  title={`${entry.name} — ${entry.caption}`}
                  icon={entry.icon}
                  disabled={entry.disabled === true}
                  onClick={entry.run}
                />
              ),
          )}
          {shownTiles.map((tile) => {
            const action = appPrimaryAction(tile);
            const url = tile.openUrl;
            return (
              <TileShell
                key={tile.key}
                label={tile.name}
                // Only a word when it isn't simply there to use ("Stopped"):
                // TileShell shows the status note over the caption.
                caption={null}
                status={tile.status}
                title={[
                  primaryActionTitle(tile, action),
                  tile.product ?? tile.caption,
                  tile.online ? "On the internet" : null,
                  url,
                ]
                  .filter(Boolean)
                  .join("\n")}
                action={action}
                actionBusy={startingId !== null && startingId === tile.machineApp?.id}
                aiNote={tile.aiNote ?? null}
                aiWarning={tile.aiWarning ?? null}
                icon={
                  <ProgramIcon
                    name={tile.name}
                    icon={tile.icon}
                    iconImage={tile.iconImage}
                    templateId={tile.templateId}
                  />
                }
                onClick={() => runTile(tile)}
                onDetails={() => openSettings(tile)}
                {...(url
                  ? {
                      pin: {
                        pinned: isPinned("app", url),
                        onToggle: () =>
                          toggle({ kind: "app", title: tile.name, target: url, icon: tile.icon }),
                      },
                    }
                  : {})}
              />
            );
          })}
          {loading && ownTiles.length === 0 && !searching
            ? [0, 1, 2].map((i) => (
                <li key={`skeleton-${i}`} className="flex flex-col items-center gap-2 pt-3">
                  <Skeleton className="size-14 rounded-2xl" />
                  <Skeleton className="h-3 w-14" />
                </li>
              ))
            : null}
        </ul>
      )}

      {!loading && ownTiles.length === 0 && !searching ? (
        <p
          className="text-center text-xs leading-relaxed text-muted-foreground"
          data-testid="apps-page-empty"
        >
          No apps of your own yet.{" "}
          {hasStore
            ? "Add one from the App Store, or ask Uno in a chat to make one."
            : "Ask Uno in a chat to make one."}
        </p>
      ) : null}

      {searching ? null : <SidebarAppServers />}
      <NotetakerConfirmDialog notetaker={notetaker} />
    </div>
  );
}
