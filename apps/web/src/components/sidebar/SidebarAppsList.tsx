/**
 * Apps mode of the sidebar: every app of the computer — from the App Store,
 * made by the person or by Uno, or found running — with a live status dot. A
 * click opens it inside Uno; hover offers "Beside a chat" and Pin. Uno Drive,
 * Terminal and the App Store sit at the bottom, like fixed items of a dock.
 */
import { useNavigate } from "@tanstack/react-router";
import {
  HardDriveIcon,
  PanelRightIcon,
  PinIcon,
  PinOffIcon,
  ShoppingBagIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { useOpenApp } from "../../navigation/useOpenApp";
import { usePins } from "../../navigation/usePins";
import { ProgramIcon, STATUS_DOT } from "../computer/ComputerPrograms";
import type { ProgramTile } from "../computer/programModel";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import { useProgramTiles } from "../computer/useProgramTiles";
import { useSidebar } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";

export const SidebarAppsList = memo(function SidebarAppsList() {
  const { tiles, loading, hasStore } = useProgramTiles();
  const machine = useActiveMachine();
  const launchers = useHomeLaunchers(machine.environmentId);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [terminalBusy, setTerminalBusy] = useState(false);
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

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
            <AppRow key={tile.key} tile={tile} onNavigate={close} />
          ))}
        </ul>
      )}

      <div className="mt-auto flex flex-col gap-px border-t border-border/60 pt-1">
        <FixedRow
          icon={<HardDriveIcon className="size-4 text-sky-500" />}
          label="Uno Drive"
          onClick={() => {
            close();
            void navigate({ to: "/drive" });
          }}
        />
        <FixedRow
          icon={<SquareTerminalIcon className="size-4" />}
          label="Terminal"
          disabled={terminalBusy}
          onClick={() => {
            close();
            setTerminalBusy(true);
            void launchers.openTerminal().finally(() => setTerminalBusy(false));
          }}
        />
        {hasStore ? (
          <FixedRow
            icon={<ShoppingBagIcon className="size-4" />}
            label="App Store"
            onClick={() => {
              close();
              void navigate({ to: "/computer", search: { store: "1" } });
            }}
          />
        ) : null}
      </div>
    </div>
  );
});

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

function AppRow({ tile, onNavigate }: { tile: ProgramTile; onNavigate: () => void }) {
  const navigate = useNavigate();
  const { openHere, openBeside } = useOpenApp();
  const { isPinned, toggle } = usePins();
  const dot = STATUS_DOT[tile.status];
  const url = tile.openUrl;
  const pinned = url ? isPinned("app", url) : false;
  const app = url ? { url, name: tile.name, icon: tile.icon } : null;

  return (
    <li className="group/app relative list-none">
      <button
        type="button"
        onClick={() => {
          onNavigate();
          // Without an address (stopped, asleep, not on the internet) the app's
          // card on Home says why and has the buttons to fix it.
          if (app) openHere(app);
          else void navigate({ to: "/computer" });
        }}
        title={url ?? `${tile.name} — ${tile.caption}`}
        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg pr-14 pl-1.5 text-left outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2"
      >
        <span className="relative shrink-0">
          <ProgramIcon
            name={tile.name}
            icon={tile.icon}
            iconImage={tile.iconImage}
            className="size-6 rounded-md text-sm shadow-none"
          />
          {dot ? (
            <span
              aria-hidden
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar",
                dot,
              )}
            />
          ) : null}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm text-sidebar-foreground">{tile.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground/80">
            {tile.caption}
          </span>
        </span>
      </button>
      {app ? (
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/app:opacity-100 focus-within:opacity-100 max-md:opacity-100">
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
              toggle({ kind: "app", title: tile.name, target: app.url, icon: tile.icon })
            }
            className={cn(
              "inline-flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground",
              pinned ? "text-primary" : "text-muted-foreground",
            )}
          >
            {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
          </button>
        </div>
      ) : null}
    </li>
  );
}
