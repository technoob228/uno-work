/**
 * Apps mode of the sidebar: every app of the computer — from the App Store,
 * made by the person or by Uno, or found running — with a live status dot. A
 * click does the app's one primary action: Open (inside Uno), Start, or Set up
 * / Fix with Uno — the last three spelled on the row. Hover offers "Beside a
 * chat" and Pin. App Store apps go by their task ("Files & documents"), the
 * product name small under it. Uno Drive,
 * Terminal and the App Store sit at the bottom, like fixed items of a dock.
 *
 * The same list is the Apps tab of "Apps & sites" (`variant="page"`): there
 * the built-in ones come first — on an empty computer the page used to say
 * "No apps yet" on top and keep Drive, Terminal and the App Store at the very
 * bottom of an empty page (P14, 28.10).
 */
import { useNavigate } from "@tanstack/react-router";
import {
  AudioLinesIcon,
  GlobeIcon,
  HardDriveIcon,
  PanelRightIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
  ShoppingBagIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { useOpenApp } from "../../navigation/useOpenApp";
import { usePins } from "../../navigation/usePins";
import { appPrimaryAction } from "../computer/appPrimaryAction";
import {
  ActionChip,
  primaryActionTitle,
  ProgramIcon,
  STATUS_NOTE,
  TileChip,
} from "../computer/ComputerPrograms";
import { NotetakerConfirmDialog, useNotetakerApp } from "../computer/NotetakerBuiltIn";
import { isNotetakerTile, NOTETAKER_NAME } from "../computer/notetakerApp";
import { useAppInstalls } from "../computer/useAppInstalls";
import type { ProgramTile } from "../computer/programModel";
import {
  type AppPrimaryRunner,
  useAppPrimaryAction,
  useStartingAppId,
} from "../computer/useAppPrimaryAction";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import { type ProgramTilesState, useProgramTiles } from "../computer/useProgramTiles";
import { useSidebar } from "../ui/sidebar";
import { SidebarAppServers } from "./SidebarAppServers";
import { Skeleton } from "../ui/skeleton";

export const SidebarAppsList = memo(function SidebarAppsList({
  variant = "sidebar",
}: {
  /** "page": the Apps tab of Apps & sites — built-in apps first, then the person's. */
  readonly variant?: "sidebar" | "page";
}) {
  const { tiles, loading, hasStore, computer } = useProgramTiles();
  const machine = useActiveMachine();
  const launchers = useHomeLaunchers(machine.environmentId);
  const primary = useAppPrimaryAction({ environmentId: machine.environmentId });
  const startingId = useStartingAppId();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [terminalBusy, setTerminalBusy] = useState(false);
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

  const openDrive = () => {
    close();
    void navigate({ to: "/drive" });
  };
  const openTerminal = () => {
    close();
    setTerminalBusy(true);
    void launchers.openTerminal().finally(() => setTerminalBusy(false));
  };
  const openStore = () => {
    close();
    void navigate({ to: "/computer", search: { store: "1" } });
  };

  if (variant === "page") {
    // Uno Notetaker is in Built in, installed or not: not twice.
    const ownTiles = tiles.filter((tile) => !isNotetakerTile(tile));
    return (
      <div className="flex flex-col gap-6" data-testid="apps-page">
        <section aria-labelledby="apps-built-in">
          <h2
            id="apps-built-in"
            className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide"
          >
            Built in
          </h2>
          <div className="grid gap-2 sm:grid-cols-3">
            <BuiltInTile
              icon={<HardDriveIcon className="size-4.5 text-sky-500" />}
              label="Uno Drive"
              hint="Your files in the cloud"
              onClick={openDrive}
            />
            <NotetakerBuiltInTile
              tiles={tiles}
              computer={computer}
              primary={primary}
              onNavigate={close}
            />
            <BuiltInTile
              icon={<SquareTerminalIcon className="size-4.5" />}
              label="Terminal"
              hint="Command line of this computer"
              disabled={terminalBusy}
              onClick={openTerminal}
            />
            {hasStore ? (
              <BuiltInTile
                icon={<ShoppingBagIcon className="size-4.5" />}
                label="App Store"
                hint="Ready-made apps, one click"
                onClick={openStore}
              />
            ) : null}
          </div>
        </section>
        <section aria-labelledby="apps-yours">
          <h2
            id="apps-yours"
            className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide"
          >
            Your apps
          </h2>
          {loading && ownTiles.length === 0 ? (
            <div className="flex flex-col gap-1.5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9 w-full rounded-lg" />
              ))}
            </div>
          ) : ownTiles.length === 0 ? (
            <div
              className="rounded-xl border border-dashed border-border px-4 py-5 text-center"
              data-testid="apps-page-empty"
            >
              <p className="text-sm text-foreground">No apps of your own yet</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {hasStore
                  ? "Add one from the App Store, or ask Uno in a chat to make one for you."
                  : "Ask Uno in a chat to make one for you."}
              </p>
              {hasStore ? (
                <button
                  type="button"
                  onClick={openStore}
                  className="mt-3 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-accent"
                >
                  <ShoppingBagIcon className="size-3.5" />
                  Open the App Store
                </button>
              ) : null}
            </div>
          ) : (
            <ul className="flex flex-col gap-px">
              {ownTiles.map((tile) => (
                <AppRow
                  key={tile.key}
                  tile={tile}
                  primary={primary}
                  starting={startingId !== null && startingId === tile.machineApp?.id}
                  onNavigate={close}
                />
              ))}
            </ul>
          )}
          <SidebarAppServers />
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-px">
      {loading && tiles.length === 0 ? (
        <div className="flex flex-col gap-1.5 px-2 pt-1">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-7 w-full rounded-md" />
          ))}
        </div>
      ) : tiles.length === 0 ? (
        <p className="px-2 py-4 text-center text-xs leading-relaxed text-muted-foreground/70">
          No apps yet.{" "}
          {hasStore
            ? "Add one from the App Store, or ask Uno to make one."
            : "Ask Uno to make one."}
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {tiles.map((tile) => (
            <AppRow
              key={tile.key}
              tile={tile}
              primary={primary}
              starting={startingId !== null && startingId === tile.machineApp?.id}
              onNavigate={close}
            />
          ))}
        </ul>
      )}

      <SidebarAppServers />

      <div className="mt-auto flex flex-col gap-px border-t border-border/60 pt-1">
        <FixedRow
          icon={<HardDriveIcon className="size-4 text-sky-500" />}
          label="Uno Drive"
          onClick={openDrive}
        />
        <FixedRow
          icon={<SquareTerminalIcon className="size-4" />}
          label="Terminal"
          disabled={terminalBusy}
          onClick={openTerminal}
        />
        {hasStore ? (
          <FixedRow
            icon={<ShoppingBagIcon className="size-4" />}
            label="App Store"
            onClick={openStore}
          />
        ) : null}
      </div>
    </div>
  );
});

function BuiltInTile({
  icon,
  label,
  hint,
  onClick,
  disabled,
  title,
  problem = false,
  trailing = null,
  onContextMenu,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  /** The hint says something went wrong (red). */
  problem?: boolean;
  /** A chip at the end ("Add", "Installing…"). */
  trailing?: React.ReactNode;
  onContextMenu?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      onContextMenu={
        onContextMenu
          ? (event) => {
              event.preventDefault();
              onContextMenu();
            }
          : undefined
      }
      className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left outline-hidden ring-ring transition-colors hover:bg-accent focus-visible:ring-2 disabled:cursor-wait"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span
          className={cn(
            "block truncate text-xs",
            problem ? "text-destructive-foreground" : "text-muted-foreground",
          )}
        >
          {hint}
        </span>
      </span>
      {trailing}
    </button>
  );
}

/**
 * Uno Notetaker in Built in, next to Uno Drive: Add (the usual install, with
 * the store's low-memory question), its progress, then it opens like any app.
 * Its own component: the install poll runs only on this page.
 */
function NotetakerBuiltInTile({
  tiles,
  computer,
  primary,
  onNavigate,
}: {
  tiles: ReadonlyArray<ProgramTile>;
  computer: ProgramTilesState["computer"];
  primary: AppPrimaryRunner;
  onNavigate: () => void;
}) {
  const machine = useActiveMachine();
  const navigate = useNavigate();
  const inFlight = useMemo(
    () => tiles.flatMap((tile) => (tile.storeApp ? [tile.storeApp] : [])),
    [tiles],
  );
  const installs = useAppInstalls({ environmentId: machine.environmentId, boxId: null, inFlight });
  const notetaker = useNotetakerApp({
    installs,
    tiles,
    computer,
    onOpen: (tile) => {
      onNavigate();
      primary.run(tile);
    },
    onDetails: (tile) => {
      onNavigate();
      void navigate({ to: "/computer", search: { app: tile.key } });
    },
  });
  const { view } = notetaker;
  const installed = notetaker.state.kind === "installed" ? notetaker.state.tile : null;
  const note = installed ? STATUS_NOTE[installed.status] : null;
  return (
    <>
      <BuiltInTile
        icon={<AudioLinesIcon className="size-4.5 text-rose-500" />}
        label={NOTETAKER_NAME}
        hint={note ? note.text : view.hint}
        problem={view.problem}
        title={view.title}
        disabled={view.disabled}
        onClick={notetaker.onClick}
        {...(notetaker.onDetails ? { onContextMenu: notetaker.onDetails } : {})}
        trailing={
          view.chip ? (
            <TileChip label={view.chip.label} busy={view.chip.busy} className="shrink-0" />
          ) : null
        }
      />
      <NotetakerConfirmDialog notetaker={notetaker} />
    </>
  );
}

function FixedRow({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm text-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 disabled:cursor-wait"
    >
      <span className="flex size-6 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
    </button>
  );
}

function AppRow({
  tile,
  primary,
  starting,
  onNavigate,
}: {
  tile: ProgramTile;
  primary: AppPrimaryRunner;
  starting: boolean;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const { openBeside } = useOpenApp();
  const { isPinned, toggle } = usePins();
  const note = STATUS_NOTE[tile.status];
  const url = tile.openUrl;
  const pinned = url ? isPinned("app", url) : false;
  const app = url ? { url, name: tile.name, icon: tile.icon } : null;
  const action = appPrimaryAction(tile);
  // ⚙: the app's settings — its card on Home (address, internet, start/stop, remove).
  const openSettings = () => {
    onNavigate();
    void navigate({ to: "/computer", search: { app: tile.key } });
  };

  return (
    <li className="group/app relative list-none">
      <button
        type="button"
        onContextMenu={(event) => {
          event.preventDefault();
          openSettings();
        }}
        onClick={() => {
          // Installing or asleep: the app's card on Home says why.
          if (action.disabled) {
            onNavigate();
            void navigate({ to: "/computer" });
            return;
          }
          onNavigate();
          primary.run(tile);
        }}
        title={[primaryActionTitle(tile, action), url].filter(Boolean).join("\n")}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg pl-1.5 text-left outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2",
          app ? "pr-20" : "pr-8",
        )}
      >
        <ProgramIcon
          name={tile.name}
          icon={tile.icon}
          iconImage={tile.iconImage}
          templateId={tile.templateId}
          className="size-6 rounded-md text-sm shadow-none"
        />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm text-sidebar-foreground">{tile.name}</span>
          <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground/80">
            {tile.online ? (
              <GlobeIcon className="size-3 shrink-0" aria-label="On the internet" />
            ) : null}
            {note ? <span className={cn("shrink-0", note.className)}>{note.text}</span> : null}
            <span className="truncate">
              {note ? " · " : null}
              {tile.product ?? tile.caption}
            </span>
          </span>
        </span>
        <ActionChip action={action} busy={starting} className="shrink-0" />
      </button>
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/app:opacity-100 focus-within:opacity-100 max-md:opacity-100">
        {app ? (
          <>
            <button
              type="button"
              aria-label={`Open ${tile.name} beside a chat`}
              title="Open beside a chat"
              onClick={() => {
                onNavigate();
                openBeside(app);
              }}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground max-md:hidden"
            >
              <PanelRightIcon className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={pinned ? `Unpin ${tile.name}` : `Pin ${tile.name}`}
              title={pinned ? "Unpin" : "Pin to the sidebar"}
              onClick={() =>
                toggle({
                  kind: "app",
                  title: tile.name,
                  target: app.url,
                  icon: tile.icon,
                })
              }
              className={cn(
                "inline-flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground",
                pinned ? "text-primary" : "text-muted-foreground",
              )}
            >
              {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
            </button>
          </>
        ) : null}
        <button
          type="button"
          aria-label={`${tile.name} settings`}
          title="Settings"
          onClick={openSettings}
          data-testid="app-row-settings"
          className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <SettingsIcon className="size-3.5" />
        </button>
      </div>
    </li>
  );
}
