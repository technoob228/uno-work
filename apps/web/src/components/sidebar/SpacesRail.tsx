/**
 * Several computers with the spaces option on (Misha 28.10, see spaces.ts):
 * each computer is its own space. This rail
 * left of the sidebar is the only place that switches: a tile per computer
 * with its status dot and how many chats work there, so what happens in the
 * other spaces is seen without mixing them in. Picking a tile makes that
 * computer the active one — the sidebar, Home, Files, Apps, Terminal and the
 * top-right chip are then about it alone.
 *
 * ⌘1…⌘9 pick a space; "+" adds a computer. With one computer there is no rail.
 * The rail also keeps the switch hard: a chat of another computer opened from a
 * link moves the space there, and the space picked last comes back on reload.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { readSavedSpace, saveSpace, useSpacesOn, useSwitchSpace } from "../../spaces";
import { useStore } from "../../store";
import { ComputerSwitcherDialogs } from "../computerSwitcher/ComputerSwitcherList";
import {
  type ComputerSwitcher,
  useComputerSwitcher,
} from "../computerSwitcher/useComputerSwitcher";
import {
  KindIcon,
  dotClass,
  statusWords,
  useLive,
  useOrdered,
  useOverviewComputers,
} from "../computer/home/ComputersOverview";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SidebarDComputer } from "./sidebarDView.logic";

export function useSpacesRailShown(): boolean {
  const many = useOverviewComputers().length > 1;
  return useSpacesOn() && many;
}

export function SpacesRail() {
  const switcher = useComputerSwitcher();
  const primaryId = usePrimaryEnvironmentId();
  const activeId = useStore((store) => store.activeEnvironmentId) ?? primaryId;
  const computers = useOrdered(useOverviewComputers());

  const switchSpace = useSwitchSpace();
  const setActiveEnvironmentId = useStore((store) => store.setActiveEnvironmentId);
  const routeEnvironmentId = useParams({ strict: false }).environmentId as string | undefined;
  const liveIds = computers.flatMap((computer) =>
    computer.environmentId !== null ? [computer.environmentId] : [],
  );

  // A chat of another computer (a link, an Inbox card, a notification) moves the
  // space with it: the screen never shows one computer's chat in another's space.
  useEffect(() => {
    if (
      routeEnvironmentId &&
      routeEnvironmentId !== activeId &&
      liveIds.includes(routeEnvironmentId)
    ) {
      setActiveEnvironmentId(routeEnvironmentId as EnvironmentId);
      saveSpace(routeEnvironmentId);
    }
  }, [routeEnvironmentId, activeId, liveIds.join(","), setActiveEnvironmentId]);

  // The space picked last comes back after a reload.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || liveIds.length === 0) return;
    restored.current = true;
    const saved = readSavedSpace();
    if (saved && saved !== activeId && liveIds.includes(saved) && !routeEnvironmentId) {
      switchSpace(saved as EnvironmentId);
    }
  }, [liveIds.join(",")]);

  const pick = (computer: SidebarDComputer) => {
    if (computer.environmentId !== null) {
      switchSpace(computer.environmentId as EnvironmentId);
      return;
    }
    const row = switcher.accountBoxes.find((box) => box.key === computer.key);
    if (row) void switcher.openAccountBox(row);
  };

  // ⌘1…⌘9: the n-th space.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const index = Number(event.key) - 1;
      const computer = Number.isInteger(index) && index >= 0 ? computers[index] : undefined;
      if (!computer) return;
      event.preventDefault();
      pick(computer);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <nav
      aria-label="Your computers"
      data-testid="spaces-rail"
      className="sticky top-0 z-30 hidden h-dvh w-(--nav-rail-width) shrink-0 flex-col items-center gap-2 border-r border-border bg-sidebar pt-3 pb-3 md:flex"
    >
      {computers.map((computer, index) =>
        computer.environmentId !== null ? (
          <LiveTile
            key={computer.key}
            computer={computer}
            index={index}
            active={computer.environmentId === activeId}
            onPick={() => pick(computer)}
          />
        ) : (
          <AsleepTile
            key={computer.key}
            computer={computer}
            index={index}
            switcher={switcher}
            onPick={() => pick(computer)}
          />
        ),
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={switcher.openAddComputer}
              aria-label="Add computer"
              className="mt-1 flex size-10 items-center justify-center rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            />
          }
        >
          <PlusIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="right">Add computer</TooltipPopup>
      </Tooltip>
      <ComputerSwitcherDialogs switcher={switcher} />
    </nav>
  );
}

function Tile(props: {
  computer: SidebarDComputer;
  index: number;
  active: boolean;
  dot: string;
  badge: number;
  dim: boolean;
  tip: string;
  busy?: boolean;
  onPick: () => void;
}) {
  const { computer } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={props.onPick}
            aria-label={`${computer.label} — ${props.tip}`}
            aria-current={props.active ? "true" : undefined}
            data-testid="spaces-rail-tile"
            className="group/tile relative flex w-full flex-col items-center gap-1 outline-none"
          />
        }
      >
        {/* The active space: a bar on the rail's edge, like workspaces in Slack. */}
        <span
          aria-hidden
          className={cn(
            "absolute top-2 left-0 w-1 rounded-r-full bg-foreground transition-all",
            props.active ? "h-6" : "h-0 group-hover/tile:h-3",
          )}
        />
        <span
          className={cn(
            "relative flex size-10 items-center justify-center rounded-xl border transition-colors",
            props.active
              ? "border-primary/50 bg-primary/10 text-primary"
              : "border-border/70 bg-card text-muted-foreground group-hover/tile:bg-accent group-hover/tile:text-foreground",
            props.dim && !props.active && "opacity-60",
          )}
        >
          {props.busy ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <KindIcon cloud={computer.cloud ?? false} className="size-4" />
          )}
          <span
            aria-hidden
            className={cn(
              "absolute -right-1 -bottom-1 size-3 rounded-full ring-2 ring-sidebar",
              props.dot,
            )}
          />
          {props.badge > 0 ? (
            <span
              className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground"
              data-testid="spaces-rail-badge"
            >
              {props.badge}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "w-full truncate px-1 text-center text-[10px] leading-tight",
            props.active ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {computer.label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="right" className="max-w-56">
        <div className="font-medium">{computer.label}</div>
        <div className="text-muted-foreground">{props.tip}</div>
        {props.index < 9 ? (
          <div className="mt-0.5 text-[10px] text-muted-foreground">⌘{props.index + 1}</div>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function LiveTile(props: {
  computer: SidebarDComputer;
  index: number;
  active: boolean;
  onPick: () => void;
}) {
  const live = useLive(props.computer.environmentId as EnvironmentId);
  const load = live.up && live.cpu !== null ? ` · CPU ${live.cpu}% · RAM ${live.mem ?? 0}%` : "";
  return (
    <Tile
      computer={props.computer}
      index={props.index}
      active={props.active}
      dot={dotClass(live, false)}
      badge={live.running.length}
      dim={!live.up}
      tip={`${statusWords(live)}${load}`}
      onPick={props.onPick}
    />
  );
}

function AsleepTile(props: {
  computer: SidebarDComputer;
  index: number;
  switcher: ComputerSwitcher;
  onPick: () => void;
}) {
  const row = props.switcher.accountBoxes.find((box) => box.key === props.computer.key) ?? null;
  const waking = row !== null && props.switcher.connecting?.boxId === row.box?.id;
  return (
    <Tile
      computer={{ ...props.computer, cloud: props.computer.cloud ?? true }}
      index={props.index}
      active={false}
      dot="bg-info"
      badge={0}
      dim
      busy={waking}
      tip={
        waking && props.switcher.connecting
          ? props.switcher.connecting.label
          : "Asleep · click to wake it (about 20 s)"
      }
      onPick={props.onPick}
    />
  );
}
