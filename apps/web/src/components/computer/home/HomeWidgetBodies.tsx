/**
 * What the built-in widgets show. Each reads what the rest of the app already
 * reads — the daemon's file list and cloud state, the account's sites, the
 * computer's programs — nothing new on the server.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  FolderIcon,
  ShoppingBagIcon,
  SparklesIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useOpenApp } from "../../../navigation/useOpenApp";
import { CloudUsageBar, formatQuota } from "../../files/CloudBrowser";
import { cloudStateQueryOptions, filesListQueryOptions } from "../../files/filesApi";
import { FILE_KIND_ICON, FILE_KIND_TINT, fileKindOf, formatModified } from "../../files/fileTypes";
import { sitesQuery } from "../../myuno/myUnoQueries";
import { Skeleton } from "../../ui/skeleton";
import { BuiltInIcon, ProgramIcon, TileShell, type BuiltInPrograms } from "../ComputerPrograms";
import type { ProgramTile } from "../programModel";
import { recentHomeEntries } from "./homeModel";

/** Tiles the Apps widget shows before "+N more". */
const APPS_WIDGET_TILES = 15;

/** "23.4 of 300 GB used" with a thin bar — the Files widget's title link. */
export function CloudUsageLink({ environmentId }: { environmentId: EnvironmentId | null }) {
  const state = useQuery(cloudStateQueryOptions(environmentId)).data;
  if (!state?.available) {
    return (
      <Link to="/files" className="flex items-center gap-0.5 hover:text-foreground">
        Open Files
        <ChevronRightIcon className="size-3.5" />
      </Link>
    );
  }
  return (
    <Link
      to="/files"
      search={{ cloud: "1" }}
      className="flex min-w-0 items-center gap-2 hover:text-foreground"
      title="Cloud storage"
    >
      <span className="truncate tabular-nums">
        {formatQuota(state.usedBytes, state.quotaBytes)}
      </span>
      {state.quotaBytes > 0 ? (
        <span className="w-14 shrink-0">
          <CloudUsageBar used={state.usedBytes} quota={state.quotaBytes} />
        </span>
      ) : null}
    </Link>
  );
}

/** The home folder's latest-changed files and folders, 2×2. */
export function FilesWidget({ environmentId }: { environmentId: EnvironmentId | null }) {
  const navigate = useNavigate();
  const list = useQuery(filesListQueryOptions(environmentId, null, false));
  const entries = recentHomeEntries(list.data?.entries ?? [], 4);
  if (list.isPending) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 rounded-xl" />
        ))}
      </div>
    );
  }
  if (list.isError || entries.length === 0) {
    return (
      <button
        type="button"
        onClick={() => void navigate({ to: "/files" })}
        className="flex w-full items-center gap-2 rounded-xl border border-dashed border-border/80 px-3 py-3 text-left text-sm text-muted-foreground hover:bg-accent/40"
      >
        <FolderIcon className="size-4" />
        {list.isError
          ? "Couldn't read your files just now. Open Files"
          : "Nothing here yet. Open Files"}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-2">
        {entries.map((entry) => {
          const kind = fileKindOf(entry.name, entry.kind === "directory");
          const Icon = FILE_KIND_ICON[kind];
          return (
            <button
              key={entry.path}
              type="button"
              title={entry.path}
              onClick={() =>
                void navigate({
                  to: "/files",
                  search: entry.kind === "directory" ? { path: entry.path } : { file: entry.path },
                })
              }
              className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border/70 bg-card/40 px-2.5 py-2 text-left transition-colors hover:bg-accent/40"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
                <Icon className={cn("size-4", FILE_KIND_TINT[kind])} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm">{entry.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {formatModified(entry.modifiedAt)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">Changed lately in your home folder</p>
    </div>
  );
}

/** The account's cloud storage in one number and a bar. */
export function CloudWidget({ environmentId }: { environmentId: EnvironmentId | null }) {
  const query = useQuery(cloudStateQueryOptions(environmentId));
  const state = query.data;
  if (query.isPending) return <Skeleton className="h-16 rounded-xl" />;
  if (!state?.available) {
    return (
      <p className="text-xs text-muted-foreground">
        {state?.message ?? "Cloud storage needs your Uno account."}
      </p>
    );
  }
  return (
    <Link to="/files" search={{ cloud: "1" }} className="flex flex-col gap-2 text-left">
      <span className="text-sm font-medium tabular-nums">
        {formatQuota(state.usedBytes, state.quotaBytes)}
      </span>
      <CloudUsageBar used={state.usedBytes} quota={state.quotaBytes} />
      <span className="text-xs text-muted-foreground">Every computer and app sees it.</span>
    </Link>
  );
}

/** Sites on Uno Hosting; a click opens one inside Uno Work. */
export function SitesWidget() {
  const query = useQuery(sitesQuery());
  const { openHere } = useOpenApp();
  const sites = query.data?.sites ?? [];
  if (query.isPending) return <Skeleton className="h-16 rounded-xl" />;
  if (query.isError) {
    return <p className="text-xs text-muted-foreground">Couldn't read your sites just now.</p>;
  }
  if (sites.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No sites yet. Publish one from Files → Share.</p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {sites.slice(0, 5).map((site) => (
        <button
          key={site.slug}
          type="button"
          onClick={() => openHere({ url: site.url, name: site.slug })}
          className="-mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent/50"
          title={site.url}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{site.customDomain ?? site.slug}</span>
        </button>
      ))}
      {sites.length > 5 ? (
        <Link to="/my-uno" className="text-[11px] text-muted-foreground hover:text-foreground">
          {sites.length - 5} more in My Uno
        </Link>
      ) : null}
    </div>
  );
}

/** Built-in programs, then this computer's apps — the same clicks as before. */
export function AppsWidget({
  builtIns,
  tiles,
  loading,
  onOpenTile,
  onTileDetails,
}: {
  builtIns: BuiltInPrograms;
  tiles: ReadonlyArray<ProgramTile>;
  loading: boolean;
  onOpenTile: (tile: ProgramTile) => void;
  onTileDetails: (tile: ProgramTile) => void;
}) {
  const [all, setAll] = useState(false);
  // Three rows of five: the four built-ins, then the apps; the rest on demand.
  const room = APPS_WIDGET_TILES - 4;
  const hidden = all || tiles.length <= room ? 0 : tiles.length - (room - 1);
  const shownTiles = hidden > 0 ? tiles.slice(0, room - 1) : tiles;
  return (
    <ul className="grid grid-cols-4 gap-x-1 gap-y-2 sm:grid-cols-5" aria-label="Apps">
      <TileShell
        small
        label="Uno"
        caption="New chat"
        title="Start a new chat with Uno"
        icon={
          <BuiltInIcon small className="bg-gradient-to-br from-primary to-primary/70">
            <SparklesIcon />
          </BuiltInIcon>
        }
        onClick={builtIns.onNewChat}
      />
      <TileShell
        small
        label="Files"
        caption="Your folders"
        disabled={builtIns.onFiles === null}
        icon={
          <BuiltInIcon small className="bg-gradient-to-br from-sky-400 to-blue-600">
            <FolderIcon />
          </BuiltInIcon>
        }
        onClick={() => builtIns.onFiles?.()}
      />
      <TileShell
        small
        label="Terminal"
        caption="Command line"
        icon={
          <BuiltInIcon small className="bg-gradient-to-br from-zinc-700 to-zinc-900">
            <SquareTerminalIcon />
          </BuiltInIcon>
        }
        onClick={builtIns.onTerminal}
      />
      <TileShell
        small
        label="App Store"
        caption={builtIns.appStoreHint ?? "Add apps"}
        title={builtIns.appStoreHint ? `App Store — ${builtIns.appStoreHint}` : "App Store"}
        disabled={builtIns.onAppStore === null}
        icon={
          <BuiltInIcon small className="bg-gradient-to-br from-fuchsia-500 to-violet-600">
            <ShoppingBagIcon />
          </BuiltInIcon>
        }
        onClick={() => builtIns.onAppStore?.()}
      />
      {shownTiles.map((tile) => (
        <TileShell
          small
          key={tile.key}
          label={tile.name}
          caption={tile.caption}
          status={tile.status}
          online={tile.online}
          title={tile.openUrl ? `Open ${tile.name}` : `${tile.name} — details`}
          icon={
            <ProgramIcon
              name={tile.name}
              icon={tile.icon}
              iconImage={tile.iconImage}
              className="size-11 rounded-[14px] text-lg"
            />
          }
          onClick={() => onOpenTile(tile)}
          onDetails={() => onTileDetails(tile)}
        />
      ))}
      {hidden > 0 ? (
        <li>
          <button
            type="button"
            onClick={() => setAll(true)}
            className="flex w-full flex-col items-center gap-1.5 rounded-2xl px-1 pt-1.5 pb-1.5 text-center transition-colors hover:bg-accent/60"
          >
            <span className="flex size-11 items-center justify-center rounded-[14px] bg-muted text-sm font-medium text-muted-foreground">
              +{hidden}
            </span>
            <span className="w-full truncate text-[11.5px] text-foreground">More</span>
          </button>
        </li>
      ) : null}
      {loading
        ? [0, 1].map((i) => (
            <li key={`skeleton-${i}`} className="flex flex-col items-center gap-1.5 pt-1.5">
              <Skeleton className="size-11 rounded-[14px]" />
              <Skeleton className="h-3 w-10" />
            </li>
          ))
        : null}
    </ul>
  );
}
