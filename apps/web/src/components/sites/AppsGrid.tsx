/**
 * The Apps tab of Apps & sites, like Launchpad on a Mac (Misha 28.10: the
 * long list of rows "looked awful — just a few rows of icons, with search").
 *
 * A search field on top, then one grid of big icons with the name under each:
 * Uno Drive, Terminal and the App Store first, then the person's apps. Typing
 * keeps only the apps that match (`appsGridModel.ts`), Enter opens the first
 * one, Esc clears. A click does the app's one primary action (Open, Start,
 * Fix with Uno…), a right click or the ⚙ on hover opens its settings on Home,
 * the pin on hover pins it to the sidebar. The port and the kind ("App · 8471")
 * moved into the tooltip — under every icon they were noise.
 */
import { useNavigate } from "@tanstack/react-router";
import {
  HardDriveIcon,
  PinIcon,
  PinOffIcon,
  SearchIcon,
  ShoppingBagIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { usePins } from "../../navigation/usePins";
import { appPrimaryAction } from "../computer/appPrimaryAction";
import {
  BuiltInIcon,
  primaryActionTitle,
  ProgramIcon,
  TileShell,
} from "../computer/ComputerPrograms";
import type { ProgramTile } from "../computer/programModel";
import { useAppPrimaryAction, useStartingAppId } from "../computer/useAppPrimaryAction";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import { useProgramTiles } from "../computer/useProgramTiles";
import { SidebarAppServers } from "../sidebar/SidebarAppServers";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { filterAppsBySearch } from "./appsGridModel";

interface BuiltIn {
  readonly key: string;
  readonly name: string;
  readonly caption: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly run: () => void;
}

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(6.75rem,1fr))] gap-x-1 gap-y-2";

export function AppsGrid() {
  const { tiles, loading, hasStore } = useProgramTiles();
  const machine = useActiveMachine();
  const launchers = useHomeLaunchers(machine.environmentId);
  const primary = useAppPrimaryAction({ environmentId: machine.environmentId });
  const startingId = useStartingAppId();
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const { isPinned, toggle } = usePins();
  const [query, setQuery] = useState("");
  const [terminalBusy, setTerminalBusy] = useState(false);

  const builtIns = useMemo<BuiltIn[]>(
    () => [
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
    ],
    [hasStore, launchers, navigate, terminalBusy],
  );

  const shownBuiltIns = filterAppsBySearch(builtIns, query);
  const shownTiles = filterAppsBySearch(tiles, query);
  const searching = query.trim() !== "";
  const nothingFound = searching && shownBuiltIns.length === 0 && shownTiles.length === 0;

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
  const openFirst = () => {
    const builtIn = shownBuiltIns.find((entry) => !entry.disabled);
    if (builtIn) builtIn.run();
    else if (shownTiles[0]) runTile(shownTiles[0]);
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
          {shownBuiltIns.map((entry) => (
            <TileShell
              key={entry.key}
              label={entry.name}
              caption={null}
              title={`${entry.name} — ${entry.caption}`}
              icon={entry.icon}
              disabled={entry.disabled === true}
              onClick={entry.run}
            />
          ))}
          {shownTiles.map((tile) => {
            const action = appPrimaryAction(tile);
            const url = tile.openUrl;
            const pinned = url ? isPinned("app", url) : false;
            return (
              <TileShell
                key={tile.key}
                label={tile.name}
                // Only a word when it isn't simply there to use ("Stopped"):
                // TileShell shows the status note over the caption.
                caption={null}
                status={tile.status}
                title={[primaryActionTitle(tile, action), tile.product ?? tile.caption, url]
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
                cornerActions={
                  url ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={pinned ? `Unpin ${tile.name}` : `Pin ${tile.name}`}
                      title={pinned ? "Unpin" : "Pin to the sidebar"}
                      className={cn(pinned && "text-primary")}
                      onClick={() =>
                        toggle({ kind: "app", title: tile.name, target: url, icon: tile.icon })
                      }
                    >
                      {pinned ? <PinOffIcon /> : <PinIcon />}
                    </Button>
                  ) : null
                }
              />
            );
          })}
          {loading && tiles.length === 0 && !searching
            ? [0, 1, 2].map((i) => (
                <li key={`skeleton-${i}`} className="flex flex-col items-center gap-2 pt-3">
                  <Skeleton className="size-14 rounded-2xl" />
                  <Skeleton className="h-3 w-14" />
                </li>
              ))
            : null}
        </ul>
      )}

      {!loading && tiles.length === 0 && !searching ? (
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
    </div>
  );
}
