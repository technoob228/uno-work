/**
 * The desktop's programs: a grid of icons, like a phone's home screen or
 * macOS Launchpad. Built-in programs first (Uno, Files, Terminal, App Store),
 * then everything on the computer — apps the person made or installed, and
 * whatever the daemon found running (a VPN in docker, a service, a web page on
 * a port).
 *
 * A click opens the program: its address in a new tab when it has one the
 * browser can reach, otherwise its details, where "Show on the internet",
 * Start and Stop live.
 *
 * Found programs the person hid ("Hide from Home") are listed under the grid,
 * each with "Show on Home" to put it back.
 */
import type { UnoMachineApp, UnoMachineApps } from "@t3tools/contracts";
import {
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  HardDriveIcon,
  InfoIcon,
  LayoutGridIcon,
  ShoppingBagIcon,
  SparklesIcon,
  SquareTerminalIcon,
  TriangleAlertIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import type { ProgramStatus, ProgramTile } from "./programModel";

/**
 * The "on the internet" badge: a solid circle with a border and a shadow, so
 * it reads on any icon colour and on cards in both themes (a `bg-background`
 * circle looked see-through on a card).
 */
export const ONLINE_BADGE_CLASS =
  "absolute -top-1.5 -right-1.5 z-[1] flex size-5 items-center justify-center rounded-full border border-black/10 bg-white text-primary shadow-sm dark:border-white/15 dark:bg-neutral-800";

export const STATUS_DOT: Record<ProgramStatus, string | null> = {
  running: "bg-success",
  stopped: "bg-muted-foreground/60",
  installing: null,
  failed: "bg-destructive",
  asleep: "bg-info",
  unknown: null,
};

const TILE_COLORS = [
  "from-sky-500/80 to-indigo-500/80",
  "from-emerald-500/80 to-teal-600/80",
  "from-amber-400/85 to-orange-500/80",
  "from-rose-500/80 to-pink-600/80",
  "from-violet-500/80 to-purple-600/80",
  "from-cyan-500/80 to-blue-600/80",
];

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length]!;
}

export function ProgramIcon({
  name,
  icon,
  iconImage,
  className,
}: {
  name: string;
  icon: string | null;
  iconImage: string | null;
  className?: string;
}) {
  // The caller's className goes last so a small icon (sidebar rows, the app
  // bar) can shrink the glyph too, not only the box.
  const base =
    "flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl shadow-sm ring-1 ring-black/5 dark:ring-white/10";
  if (iconImage) {
    // App Store logos (served by Uno) are brand marks: whole, on white, with air.
    const logo = iconImage.includes("/api/v1/apps/icons/");
    return (
      <span className={cn(base, logo ? "bg-white p-[18%]" : "bg-card", className)}>
        <img
          src={iconImage}
          alt=""
          className={cn("size-full", logo ? "object-contain" : "object-cover")}
          draggable={false}
        />
      </span>
    );
  }
  if (icon) {
    return (
      <span className={cn(base, "bg-card text-[1.75rem] leading-none", className)}>{icon}</span>
    );
  }
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span
      className={cn(
        base,
        "bg-gradient-to-br text-xl font-semibold text-white",
        colorFor(name),
        className,
      )}
    >
      {letter}
    </span>
  );
}

export function TileShell({
  label,
  caption,
  icon,
  status,
  online,
  disabled,
  onClick,
  onDetails,
  title,
  aiNote = null,
  aiWarning = null,
  small = false,
}: {
  /** "Anyone with the link can use this app's AI — add sign-in": an amber mark. */
  aiWarning?: string | null;
  /** "Uses AI for answers · Uno AI · $0.40 of $10" — a small mark and a tooltip line. */
  aiNote?: string | null;
  /** Home's Apps widget: tighter, no caption. */
  small?: boolean;
  label: string;
  caption: string | null;
  icon: ReactNode;
  status?: ProgramStatus;
  online?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDetails?: () => void;
  title?: string;
}) {
  const dot = status ? STATUS_DOT[status] : null;
  return (
    <li className="group relative">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        title={[title ?? label, aiNote, aiWarning ? `⚠ ${aiWarning} (Settings → Apps)` : null]
          .filter(Boolean)
          .join("\n")}
        className={cn(
          "flex w-full flex-col items-center rounded-2xl px-1 text-center outline-hidden transition-colors",
          // Room above the icon for the "on the internet" badge, so a card edge
          // never cuts it.
          small ? "gap-1.5 pt-2.5 pb-1.5" : "gap-2 pt-3 pb-2",
          "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-default disabled:opacity-55 disabled:hover:bg-transparent",
        )}
      >
        <span className="relative transition-transform duration-150 group-hover:-translate-y-0.5">
          {icon}
          {status === "installing" ? (
            <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-background ring-1 ring-border">
              <Spinner className="size-3" />
            </span>
          ) : dot ? (
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 size-3 rounded-full ring-2 ring-background",
                dot,
              )}
              aria-hidden
            />
          ) : null}
          {aiWarning ? (
            <span
              className="absolute -top-1 -left-1 flex size-4 items-center justify-center rounded-full bg-amber-500 text-white shadow-sm ring-1 ring-background"
              aria-label={aiWarning}
              data-testid="program-ai-warning"
            >
              <TriangleAlertIcon className="size-2.5" />
            </span>
          ) : aiNote ? (
            <span
              className="absolute -top-1 -left-1 flex size-4 items-center justify-center rounded-full bg-background text-primary shadow-sm ring-1 ring-border"
              aria-label={aiNote}
              data-testid="program-ai-badge"
            >
              <WandSparklesIcon className="size-2.5" />
            </span>
          ) : null}
          {online ? (
            <span
              className={ONLINE_BADGE_CLASS}
              title="On the internet"
              data-testid="program-online-badge"
            >
              <GlobeIcon className="size-3" />
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "w-full truncate text-foreground",
            small ? "text-[11.5px]" : "text-xs font-medium",
          )}
        >
          {label}
        </span>
        {caption && !small ? (
          <span className="-mt-1.5 w-full truncate text-[11px] text-muted-foreground">
            {caption}
          </span>
        ) : null}
      </button>
      {onDetails ? (
        <Button
          size="icon-xs"
          variant="ghost"
          className="absolute top-1 right-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          aria-label={`About ${label}`}
          onClick={onDetails}
        >
          <InfoIcon />
        </Button>
      ) : null}
    </li>
  );
}

export function BuiltInIcon({
  children,
  className,
  small = false,
}: {
  children: ReactNode;
  className: string;
  small?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex items-center justify-center text-white shadow-sm ring-1 ring-black/5 dark:ring-white/10",
        small ? "size-11 rounded-[14px] [&_svg]:size-5" : "size-14 rounded-2xl [&_svg]:size-7",
        className,
      )}
    >
      {children}
    </span>
  );
}

export interface BuiltInPrograms {
  readonly onNewChat: () => void;
  readonly onChatInFolder: () => void;
  /** Null until the Files app ships in this build. */
  readonly onFiles: (() => void) | null;
  /** Uno Drive (Made by Uno); null when this computer isn't on an Uno account. */
  readonly onDrive?: (() => void) | null | undefined;
  readonly onTerminal: () => void;
  readonly onAppStore: (() => void) | null;
  readonly appStoreHint: string | null;
}

export function ComputerPrograms({
  builtIns,
  showBuiltIns,
  tiles,
  machineApps,
  loading,
  onOpenTile,
  onTileDetails,
  hidden = [],
  unhidingId = null,
  onUnhide,
}: {
  builtIns: BuiltInPrograms;
  /** False when looking at another cloud computer: the launchers act on this machine. */
  showBuiltIns: boolean;
  tiles: ReadonlyArray<ProgramTile>;
  machineApps: UnoMachineApps | undefined;
  loading: boolean;
  onOpenTile: (tile: ProgramTile) => void;
  onTileDetails: (tile: ProgramTile) => void;
  /** Found programs hidden from the home screen. */
  hidden?: ReadonlyArray<UnoMachineApp>;
  unhidingId?: string | null;
  onUnhide?: (appId: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="programs-heading">
      <header className="flex flex-wrap items-center gap-2">
        <h2 id="programs-heading" className="text-sm font-semibold text-foreground">
          Programs
        </h2>
        {showBuiltIns ? (
          <div className="ml-auto flex items-center gap-1">
            <Button size="xs" variant="outline" onClick={builtIns.onChatInFolder}>
              <FolderOpenIcon />
              Start a chat in a folder…
            </Button>
          </div>
        ) : null}
      </header>

      <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6" aria-label="Programs">
        {showBuiltIns ? (
          <>
            <TileShell
              label="Uno"
              caption="New chat"
              title="Start a new chat with Uno"
              icon={
                <BuiltInIcon className="bg-gradient-to-br from-primary to-primary/70">
                  <SparklesIcon />
                </BuiltInIcon>
              }
              onClick={builtIns.onNewChat}
            />
            <TileShell
              label="Files"
              caption={builtIns.onFiles ? "Your folders" : "Coming soon"}
              disabled={builtIns.onFiles === null}
              icon={
                <BuiltInIcon className="bg-gradient-to-br from-sky-400 to-blue-600">
                  <FolderIcon />
                </BuiltInIcon>
              }
              onClick={() => builtIns.onFiles?.()}
            />
            {builtIns.onDrive !== undefined ? (
              <TileShell
                label="Uno Drive"
                caption={builtIns.onDrive ? "Cloud storage" : "Needs your Uno account"}
                title="Uno Drive — your Cloud storage, also from Telegram. Made by Uno."
                disabled={builtIns.onDrive === null}
                icon={
                  <BuiltInIcon className="bg-gradient-to-br from-sky-400 to-indigo-600">
                    <HardDriveIcon />
                  </BuiltInIcon>
                }
                onClick={() => builtIns.onDrive?.()}
              />
            ) : null}
            <TileShell
              label="Terminal"
              caption="Command line"
              icon={
                <BuiltInIcon className="bg-gradient-to-br from-zinc-700 to-zinc-900">
                  <SquareTerminalIcon />
                </BuiltInIcon>
              }
              onClick={builtIns.onTerminal}
            />
            <TileShell
              label="App Store"
              caption={builtIns.appStoreHint ?? "Add apps"}
              disabled={builtIns.onAppStore === null}
              icon={
                <BuiltInIcon className="bg-gradient-to-br from-fuchsia-500 to-violet-600">
                  <ShoppingBagIcon />
                </BuiltInIcon>
              }
              onClick={() => builtIns.onAppStore?.()}
            />
          </>
        ) : null}

        {tiles.map((tile) => (
          <TileShell
            key={tile.key}
            label={tile.name}
            caption={tile.caption}
            status={tile.status}
            online={tile.online}
            title={tile.openUrl ? `Open ${tile.name}` : `${tile.name} — details`}
            aiNote={tile.aiNote ?? null}
            aiWarning={tile.aiWarning ?? null}
            icon={<ProgramIcon name={tile.name} icon={tile.icon} iconImage={tile.iconImage} />}
            onClick={() => onOpenTile(tile)}
            onDetails={() => onTileDetails(tile)}
          />
        ))}

        {loading && !machineApps
          ? [0, 1].map((i) => (
              <li key={`skeleton-${i}`} className="flex flex-col items-center gap-2 pt-3">
                <Skeleton className="size-14 rounded-2xl" />
                <Skeleton className="h-3 w-12" />
              </li>
            ))
          : null}
      </ul>

      <ProgramsFootnote
        machineApps={machineApps}
        empty={tiles.length === 0}
        hidden={hidden}
        unhidingId={unhidingId}
        onUnhide={onUnhide}
      />
    </section>
  );
}

function ProgramsFootnote({
  machineApps,
  empty,
  hidden,
  unhidingId,
  onUnhide,
}: {
  machineApps: UnoMachineApps | undefined;
  empty: boolean;
  hidden: ReadonlyArray<UnoMachineApp>;
  unhidingId: string | null;
  onUnhide: ((appId: string) => void) | undefined;
}) {
  if (!machineApps) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      <p className="flex items-start gap-2">
        <LayoutGridIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span>
          {empty && hidden.length === 0
            ? "Nothing else runs here yet. "
            : "Everything that runs on this computer shows up here by itself — a VPN, a bot, a site. "}
          Ask Uno to make you an app and it appears here too; apps can also be registered in{" "}
          <code className="rounded bg-muted px-1 font-mono text-[11px]">
            {machineApps.manifestDir}
          </code>
          .
        </span>
      </p>
      {onUnhide ? (
        <HiddenPrograms
          hidden={hidden}
          unhidingId={unhidingId}
          onUnhide={onUnhide}
          className="pl-5.5"
        />
      ) : null}
      {machineApps.warnings.length > 0 ? (
        <details className="pl-5.5">
          <summary className="cursor-pointer select-none">
            {machineApps.warnings.length === 1
              ? "1 app file couldn't be read"
              : `${machineApps.warnings.length} app files couldn't be read`}
          </summary>
          <ul className="mt-1 list-disc pl-4 font-mono text-[11px]">
            {machineApps.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Found programs the person hid ("Hide from Home"), each with "Show on Home" —
 * under the Programs grid and under Home's Apps widget.
 */
export function HiddenPrograms({
  hidden,
  unhidingId,
  onUnhide,
  className,
}: {
  hidden: ReadonlyArray<UnoMachineApp>;
  unhidingId: string | null;
  onUnhide: (appId: string) => void;
  className?: string;
}) {
  if (hidden.length === 0) return null;
  return (
    <details className={className} data-testid="hidden-programs">
      <summary className="cursor-pointer select-none">
        {hidden.length === 1
          ? "1 program is hidden from Home"
          : `${hidden.length} programs are hidden from Home`}
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1" aria-label="Hidden programs">
        {hidden.map((app) => (
          <li key={app.id} className="flex items-center gap-2">
            <ProgramIcon
              name={app.name}
              icon={app.icon}
              iconImage={app.iconImage}
              className="size-6 rounded-md text-sm shadow-none"
            />
            <span className="min-w-0 flex-1 truncate text-foreground">{app.name}</span>
            <span className="truncate text-[11px]">{app.detail}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={unhidingId !== null}
              onClick={() => onUnhide(app.id)}
            >
              {unhidingId === app.id ? <Spinner className="size-3" /> : null}
              Show on Home
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
