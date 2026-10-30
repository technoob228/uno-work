/**
 * Several computers (Misha 28.10 picked variant C; spaces as an option in
 * Settings — see spaces.ts; the spaces rail reuses useLive, dotClass… from here).
 *
 * Variant C of several computers (Misha 28.10): no "current computer" in the
 * header — the top-right chip shows every computer at once (a mark each: its
 * kind, a status dot, a tiny CPU bar), and its menu is "Your computers": a row
 * per computer with the status in words, live CPU / memory / disk and what it
 * is doing; a row opens into that computer's details (the old menu, for the
 * page's own computer). Misha: "they keep falling off" — the link is said
 * plainly per computer (Reconnecting…, Not reachable, Asleep) with how often
 * it dropped lately.
 *
 * With one computer the old chip stays (ComputerPill decides).
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CloudIcon,
  CpuIcon,
  HardDriveIcon,
  LaptopIcon,
  LayoutGridIcon,
  Loader2Icon,
  MemoryStickIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "../../../environments/primary/context";
import { useSpaceScope, useSwitchSpace } from "../../../spaces";
import { selectEnvironmentState, useStore } from "../../../store";
import { useSidebarDComputers } from "../../sidebar/SidebarDComputers";
import type { SidebarDComputer } from "../../sidebar/sidebarDView.logic";
import { ComputerSwitcherDialogs } from "../../computerSwitcher/ComputerSwitcherList";
import {
  type ComputerSwitcher,
  useComputerSwitcher,
} from "../../computerSwitcher/useComputerSwitcher";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { localMetricsQueryOptions } from "../computerQueries";
import { formatGb, formatMemory, percent } from "../computerFormat";
import { Meter } from "../computerUi";
import { CONNECTION_ACTION_LABEL } from "./connectionStatus";
import { type ComputerConnection, useComputerConnection } from "./useComputerConnection";

/** The computers the overview shows: connected ones and the ones asleep on the account. */
export function useOverviewComputers(): ReadonlyArray<SidebarDComputer> {
  return useSidebarDComputers();
}

// ── The link's recent drops (per computer, this page's lifetime) ─────────

const DROP_WINDOW_MS = 60 * 60_000;
const drops = new Map<string, number[]>();

function recordDrop(environmentId: string) {
  const now = Date.now();
  const list = (drops.get(environmentId) ?? []).filter((at) => now - at < DROP_WINDOW_MS);
  list.push(now);
  drops.set(environmentId, list);
}

function recentDrops(environmentId: string): number[] {
  const now = Date.now();
  return (drops.get(environmentId) ?? []).filter((at) => now - at < DROP_WINDOW_MS);
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── What one computer is doing right now ─────────────────────────────────

interface Live {
  readonly connection: ComputerConnection;
  readonly up: boolean;
  readonly cpu: number | null;
  readonly mem: number | null;
  readonly disk: number | null;
  readonly memLine: string | null;
  readonly diskLine: string | null;
  /** CPU, memory or disk close to full. */
  readonly strained: "cpu" | "memory" | "disk" | null;
  readonly running: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>;
}

/** Was the link up when last seen (any component): a drop is counted once. */
const lastUp = new Map<string, boolean>();

export function useLive(environmentId: EnvironmentId): Live {
  const connection = useComputerConnection(environmentId);
  const up = connection.status.kind === "connected";
  useEffect(() => {
    if (lastUp.get(environmentId) === true && !up) recordDrop(environmentId);
    lastUp.set(environmentId, up);
  }, [up, environmentId]);
  const metrics = useQuery(localMetricsQueryOptions(environmentId, up)).data;
  const envState = useStore((state) => selectEnvironmentState(state, environmentId));
  const running = useMemo(
    () =>
      envState.threadIds.flatMap((id) => {
        const thread = envState.sidebarThreadSummaryById[id];
        return thread && !thread.archivedAt && thread.session?.status === "running"
          ? [{ id: thread.id, title: thread.title }]
          : [];
      }),
    [envState],
  );
  const cpu = up && metrics?.cpuPct != null ? Math.round(metrics.cpuPct) : null;
  const mem = up && metrics ? Math.round(percent(metrics.memUsedMb, metrics.memTotalMb)) : null;
  const disk = up && metrics ? Math.round(percent(metrics.diskUsedGb, metrics.diskTotalGb)) : null;
  const strained =
    disk !== null && disk >= 90
      ? "disk"
      : mem !== null && mem >= 90
        ? "memory"
        : cpu !== null && cpu >= 85
          ? "cpu"
          : null;
  return {
    connection,
    up,
    cpu,
    mem,
    disk,
    memLine:
      metrics && up
        ? `${formatMemory(metrics.memUsedMb)} of ${formatMemory(metrics.memTotalMb)}`
        : null,
    diskLine:
      metrics?.diskUsedGb != null && metrics.diskTotalGb != null && up
        ? `${formatGb(metrics.diskUsedGb)} of ${formatGb(metrics.diskTotalGb)}`
        : null,
    strained,
    running,
  };
}

/** The dot: green when fine, amber pulse while the link is coming back, red when it's gone. */
export function dotClass(live: Live | null, asleep: boolean): string {
  if (asleep || live?.connection.status.kind === "asleep") return "bg-info";
  if (!live) return "bg-muted-foreground/40";
  switch (live.connection.status.kind) {
    case "connected":
      return live.strained ? "bg-destructive" : "bg-success";
    case "connecting":
    case "reconnecting":
    case "waking":
      return "animate-pulse bg-amber-500";
    default:
      return "bg-destructive/80";
  }
}

/** One short line: what it is doing, or what is wrong with the link. */
export function statusWords(live: Live): string {
  const status = live.connection.status;
  if (status.kind !== "connected") return status.chip ?? status.line;
  const working = live.running.length;
  if (live.strained === "disk") return "Disk almost full";
  if (live.strained === "memory") return "Memory almost full";
  if (live.strained === "cpu") return working > 0 ? `Busy · ${working} working` : "Busy";
  return working > 0 ? `On · ${working} chat${working === 1 ? "" : "s"} working` : "On · idle";
}

export function KindIcon({ cloud, className }: { cloud: boolean; className?: string }) {
  const Icon = cloud ? CloudIcon : LaptopIcon;
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />;
}

// ── The chip: a mark per computer ────────────────────────────────────────

function LiveMark(props: {
  computer: SidebarDComputer;
  current: boolean;
  quiet: boolean;
  lead: string;
}) {
  const live = useLive(props.computer.environmentId as EnvironmentId);
  return <Mark {...props} live={live} />;
}

function Mark({
  computer,
  live,
  current = false,
  quiet = false,
  lead = "",
}: {
  computer: SidebarDComputer;
  live: Live | null;
  /** The one computer the chip names: the chat's or the space's. Home has none. */
  current?: boolean;
  /** Just the status dot: a chat's or a space's chip names only its own computer. */
  quiet?: boolean;
  /** The tooltip's start, "This chat runs on " in a chat. */
  lead?: string;
}) {
  const asleep = computer.status === "sleeping" && !live;
  const title = `${lead}${computer.label} · ${live ? statusWords(live) : "Asleep"}`;
  if (quiet) {
    return (
      <span
        className={cn("size-1.5 shrink-0 rounded-full", dotClass(live, asleep))}
        data-testid="computers-chip-mark"
        title={title}
      />
    );
  }
  return (
    <span
      className="flex min-w-0 items-center gap-1"
      data-testid="computers-chip-mark"
      title={title}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", dotClass(live, asleep))} aria-hidden />
      <KindIcon cloud={computer.cloud ?? false} className="size-3 text-muted-foreground" />
      <span
        className={cn(
          "truncate text-[11px]",
          current ? "max-w-40 font-medium" : "max-w-20",
          live?.up ? "text-foreground/90" : "text-muted-foreground",
        )}
      >
        {computer.label}
      </span>
      {live?.up && live.cpu !== null ? <Meter value={live.cpu} className="h-1 w-5" /> : null}
    </span>
  );
}

// ── The menu: a row per computer ─────────────────────────────────────────

function Bars({ live }: { live: Live }) {
  const rows: Array<{ icon: ReactNode; pct: number | null; label: string }> = [
    { icon: <CpuIcon />, pct: live.cpu, label: live.cpu !== null ? `${live.cpu}%` : "—" },
    { icon: <MemoryStickIcon />, pct: live.mem, label: live.memLine ?? "—" },
    { icon: <HardDriveIcon />, pct: live.disk, label: live.diskLine ?? "—" },
  ];
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-[11px]">
      {rows.map((row, index) => (
        <span key={index} className="contents [&>svg]:size-3 [&>svg]:text-muted-foreground">
          {row.icon}
          <Meter value={row.pct ?? 0} className="h-1" />
          <span className="min-w-16 text-right text-muted-foreground tabular-nums">
            {row.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function LiveRow(props: {
  computer: SidebarDComputer;
  isThis: boolean;
  /** The tag on the row of the computer on screen: "this chat", "this space"; Home has none. */
  thisWord: string | null;
  /** Spaces on: switch to this computer's space (null — spaces off). */
  onSwitchSpace: (() => void) | null;
  open: boolean;
  onToggle: () => void;
  thisDetails: ReactNode;
  switcher: ComputerSwitcher;
  onClose: () => void;
}) {
  const { computer } = props;
  const environmentId = computer.environmentId as EnvironmentId;
  const live = useLive(environmentId);
  const navigate = useNavigate();
  const status = live.connection.status;
  const dropped = recentDrops(environmentId);
  const openChat = (threadId: ThreadId) => {
    props.onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    } as never);
  };
  return (
    <li className="list-none" data-testid="computers-row">
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/60",
          props.open && "bg-accent/40",
        )}
      >
        <span className="relative mt-0.5">
          <KindIcon cloud={computer.cloud ?? false} className="size-4 text-muted-foreground" />
          <span
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-popover",
              dotClass(live, false),
            )}
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-sm font-medium">{computer.label}</span>
            {props.isThis && props.thisWord ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">{props.thisWord}</span>
            ) : null}
          </span>
          <span
            className={cn(
              "block truncate text-xs",
              live.strained || status.attention
                ? "font-medium text-destructive"
                : "text-muted-foreground",
            )}
            data-testid="computers-row-status"
          >
            {statusWords(live)}
          </span>
          {live.up ? (
            <span className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
              <MiniBar label="CPU" pct={live.cpu} />
              <MiniBar label="RAM" pct={live.mem} />
              <MiniBar label="Disk" pct={live.disk} />
            </span>
          ) : null}
        </span>
        {props.onSwitchSpace && !props.isThis ? (
          // Spaces on: the chip switches spaces too (Misha 28.10), not only the rail.
          <span
            role="button"
            tabIndex={0}
            data-testid="computers-row-switch"
            onClick={(event) => {
              event.stopPropagation();
              props.onClose();
              props.onSwitchSpace?.();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              props.onClose();
              props.onSwitchSpace?.();
            }}
            className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] font-medium hover:bg-accent"
          >
            Switch
          </span>
        ) : null}
        <ChevronRightIcon
          className={cn(
            "mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform",
            props.open && "rotate-90",
          )}
        />
      </button>
      {props.open ? (
        <div className="mb-1 ml-8 flex flex-col gap-2.5 border-l border-border/60 py-1 pr-2 pl-3">
          {status.kind !== "connected" ? (
            <div className="flex items-center gap-2 text-xs" role="status">
              <span className="min-w-0 flex-1 text-foreground">{status.line}</span>
              {live.connection.act && status.action ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={live.connection.acting}
                  onClick={live.connection.act}
                >
                  {CONNECTION_ACTION_LABEL[status.action]}
                </Button>
              ) : null}
            </div>
          ) : null}
          {props.isThis && props.thisDetails ? (
            props.thisDetails
          ) : live.up ? (
            <Bars live={live} />
          ) : null}
          {live.strained && !props.isThis ? (
            <p className="flex items-start gap-1.5 text-[11px] text-destructive">
              <TriangleAlertIcon className="mt-px size-3 shrink-0" />
              {live.strained === "disk"
                ? "The disk is almost full — new files and apps may not fit."
                : live.strained === "memory"
                  ? "Running low on memory — programs may slow down."
                  : "The processor is busy — chats may answer slower."}
            </p>
          ) : null}
          {live.running.length > 0 ? (
            <div className="flex flex-col">
              <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                Working now
              </span>
              {live.running.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => openChat(thread.id)}
                  className="flex items-center gap-1.5 rounded-md py-1 text-left text-xs hover:text-foreground"
                >
                  <Loader2Icon className="size-3 shrink-0 animate-spin text-muted-foreground" />
                  <span className="truncate">{thread.title}</span>
                </button>
              ))}
            </div>
          ) : null}
          <p className="text-[11px] text-muted-foreground" data-testid="computers-row-drops">
            {dropped.length === 0
              ? "Link steady this past hour."
              : `Link dropped ${dropped.length}× in the last hour, last at ${clock(dropped.at(-1)!)}.`}
          </p>
          {!props.isThis && live.up ? (
            <button
              type="button"
              onClick={() => {
                props.onClose();
                if (props.onSwitchSpace) props.onSwitchSpace();
                else
                  props.switcher.openMachine(
                    environmentId,
                    computer.cloud ? "uno_box" : "computer",
                  );
              }}
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {props.onSwitchSpace ? "Switch to its space" : "Open its files and apps"}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function MiniBar({ label, pct }: { label: string; pct: number | null }) {
  return (
    <span className="flex items-center gap-1">
      {label}
      <Meter value={pct ?? 0} className="h-1 w-8" />
      <span className="w-7">{pct !== null ? `${pct}%` : "—"}</span>
    </span>
  );
}

/** A cloud computer on the account nothing has connected to (asleep): Wake opens it. */
function AsleepRow(props: { computer: SidebarDComputer; switcher: ComputerSwitcher }) {
  const { computer, switcher } = props;
  const row = switcher.accountBoxes.find((box) => box.key === computer.key) ?? null;
  const waking = row !== null && switcher.connecting?.boxId === row.box?.id;
  return (
    <li className="list-none" data-testid="computers-row">
      <div className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2">
        <span className="relative mt-0.5">
          <KindIcon cloud={computer.cloud ?? true} className="size-4 text-muted-foreground/70" />
          <span
            className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-info ring-2 ring-popover"
            aria-hidden
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-muted-foreground">
            {computer.label}
          </span>
          <span
            className="block truncate text-xs text-muted-foreground"
            data-testid="computers-row-status"
          >
            {waking && switcher.connecting
              ? switcher.connecting.label
              : "Asleep · its chats wait until it wakes"}
          </span>
        </span>
        {row ? (
          <Button
            size="xs"
            variant="outline"
            disabled={switcher.connecting !== null}
            onClick={() => void switcher.openAccountBox(row)}
          >
            {waking ? <Loader2Icon className="size-3 animate-spin" /> : null}
            Wake
          </Button>
        ) : null}
      </div>
    </li>
  );
}

// ── The whole thing ──────────────────────────────────────────────────────

export function ComputersPill(props: {
  computers: ReadonlyArray<SidebarDComputer>;
  /** The computer on screen: the open chat's, or the one picked on Home. */
  focusId: EnvironmentId | null;
  /** The page's own computer, folded the old way (bars, Memory / cores, Sleep…). */
  thisDetails: ReactNode;
  fit: "home" | "chat";
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const inChat = props.fit === "chat";
  const switcher = useComputerSwitcher(() => setOpen(false), inChat ? props.focusId : undefined);
  const primaryId = usePrimaryEnvironmentId();
  // Spaces on: a row switches to that computer's space.
  const spaceScope = useSpaceScope();
  const switchSpace = useSwitchSpace();
  const thisId = props.focusId ?? spaceScope ?? primaryId;
  const thisWord = spaceScope ? "this space" : inChat ? "this chat" : null;
  // Home has no computer of its own: all are named, none set apart.
  const focused = thisWord !== null;
  const chatComputer = inChat
    ? props.computers.find((computer) => computer.environmentId === thisId)
    : undefined;
  // The computer on screen first, then the others that answer, the asleep ones last.
  const computers = useMemo(
    () =>
      props.computers.toSorted(
        (a, b) =>
          (focused ? Number(b.environmentId === thisId) - Number(a.environmentId === thisId) : 0) ||
          Number(a.environmentId === null) - Number(b.environmentId === null),
      ),
    [focused, props.computers, thisId],
  );
  const asleep = computers.filter((computer) => computer.environmentId === null).length;
  const summary = `${computers.length} computers${asleep > 0 ? ` · ${asleep} asleep` : ""}`;
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setExpanded(null);
        }}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid={props.fit === "home" ? "home-computer-pill" : "chat-computer-chip"}
              aria-label={
                chatComputer
                  ? `This chat runs on ${chatComputer.label} — your computers`
                  : `Your computers — ${summary}`
              }
              title={chatComputer ? `This chat runs on ${chatComputer.label}` : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-full border border-border/70 bg-card/60 text-xs transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                props.fit === "home"
                  ? "h-8 max-w-[34rem] pr-2.5 pl-3"
                  : "h-7 max-w-[26rem] px-2.5 sm:h-6",
              )}
            >
              {computers.map((computer) =>
                computer.environmentId !== null ? (
                  <LiveMark
                    key={computer.key}
                    computer={computer}
                    current={focused && computer.environmentId === thisId}
                    quiet={focused && computer.environmentId !== thisId}
                    lead={chatComputer === computer ? "This chat runs on " : ""}
                  />
                ) : (
                  <Mark key={computer.key} computer={computer} live={null} quiet={focused} />
                ),
              )}
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          }
        />
        <PopoverPopup
          align="end"
          className="max-h-[min(85vh,760px)] w-[min(420px,calc(100vw-1.5rem))] overflow-y-auto"
        >
          <div className="flex flex-col gap-1" data-testid="computers-menu">
            <div className="flex items-baseline justify-between px-2 pb-1">
              <span className="text-sm font-semibold">
                Your computers
                {spaceScope ? (
                  <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                    · a space each
                  </span>
                ) : null}
              </span>
              <span className="text-[11px] text-muted-foreground">{summary}</span>
            </div>
            <ul className="flex flex-col">
              {computers.map((computer) =>
                computer.environmentId !== null ? (
                  <LiveRow
                    key={computer.key}
                    computer={computer}
                    isThis={computer.environmentId === thisId}
                    thisWord={thisWord}
                    onSwitchSpace={
                      spaceScope ? () => switchSpace(computer.environmentId as EnvironmentId) : null
                    }
                    open={expanded === computer.key}
                    onToggle={() =>
                      setExpanded((current) => (current === computer.key ? null : computer.key))
                    }
                    thisDetails={props.thisDetails}
                    switcher={switcher}
                    onClose={() => setOpen(false)}
                  />
                ) : (
                  <AsleepRow key={computer.key} computer={computer} switcher={switcher} />
                ),
              )}
            </ul>
            <div className="-mx-1 mt-1 flex flex-col border-t border-border/60 pt-1.5">
              <FooterRow icon={<LayoutGridIcon />} onClick={switcher.goAllComputers}>
                All computers, sites and plan
              </FooterRow>
              <FooterRow icon={<PlusIcon />} onClick={switcher.openAddComputer}>
                Add computer
              </FooterRow>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      <ComputerSwitcherDialogs switcher={switcher} />
    </>
  );
}

function FooterRow(props: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
    >
      {props.icon}
      <span className="flex-1">{props.children}</span>
    </button>
  );
}

// ── Order ───────────────────────────────────────────────────────────────

/** Ordered: this window's computer, then the others that answer, the asleep ones last. */
export function useOrdered(computers: ReadonlyArray<SidebarDComputer>) {
  const primaryId = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      computers.toSorted(
        (a, b) =>
          Number(b.environmentId === primaryId) - Number(a.environmentId === primaryId) ||
          Number(a.environmentId === null) - Number(b.environmentId === null),
      ),
    [computers, primaryId],
  );
}
