/**
 * The computer, folded into one line in Home's header: is it on, how busy it
 * is (three tiny meters), boosted or not. A click opens the old hero as a
 * popover — size, live load with values, Boost, "Memory / cores", Sleep /
 * Turn off / Wake up, and the ways deeper: "What's using my computer" and
 * "All my computers". The same details make the "This computer" widget.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  GlobeIcon,
  HardDriveIcon,
  LayoutGridIcon,
  MemoryStickIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  PowerIcon,
  SunIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Skeleton } from "../../ui/skeleton";
import { Spinner } from "../../ui/spinner";
import { POWER_DOT, type ComputerLoad, type PowerAction } from "../ComputerHero";
import {
  POWER_STATE_LABEL,
  computerPowerState,
  displayAddress,
  formatGb,
  formatMemory,
  percent,
  type ComputerPowerState,
} from "../computerFormat";
import { Meter } from "../computerUi";
import type { ResourceLook } from "../resources/resourceModel";

export interface HomeComputer {
  readonly name: string;
  readonly subtitle: string | null;
  /** Control-plane status; null for a machine that is simply on (a laptop). */
  readonly status: string | null;
  readonly address: string | null;
  readonly load: ComputerLoad | null;
  readonly boosted: boolean;
  /** `<BoostControl size="xs" />`, or null when boost isn't offered. */
  readonly boost: ReactNode;
  readonly onResize?: (() => void) | undefined;
  /** Null when this computer's power isn't ours to switch (a laptop, no account). */
  readonly power: {
    readonly pendingAction: PowerAction | null;
    readonly error: string | null;
    /** Sleep and Turn off are confirmed by the caller first. */
    readonly onPower: (action: PowerAction) => void;
  } | null;
  readonly onOpenLook?: ((look: ResourceLook) => void) | undefined;
  readonly onAllComputers?: (() => void) | undefined;
  /** Steadily short of memory or disk: said in the details, a warning dot on the pill. */
  readonly lowResource?: "memory" | "disk" | null | undefined;
}

function powerStateOf(computer: HomeComputer): ComputerPowerState {
  return computer.status === null ? "on" : computerPowerState(computer.status);
}

function loadPercents(load: ComputerLoad | null) {
  return {
    cpu: load?.cpuPct != null ? Math.round(load.cpuPct) : null,
    mem: load?.memUsedMb != null ? percent(load.memUsedMb, load.memTotalMb) : null,
    disk: load?.diskUsedGb != null ? percent(load.diskUsedGb, load.diskTotalGb) : null,
  };
}

function MiniMeter({ label, pct }: { label: string; pct: number | null }) {
  return (
    <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground md:flex">
      {label}
      <Meter value={pct ?? 0} className="h-1 w-8" />
    </span>
  );
}

export function ComputerPill({
  computer,
  loading,
}: {
  computer: HomeComputer | null;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (loading || computer === null) {
    return <Skeleton className="h-8 w-56 rounded-full" />;
  }
  const state = powerStateOf(computer);
  const pct = loadPercents(computer.load);
  // Dialogs (resize, sleep) outlive the popover: close it as they open.
  const closeThen = (fn: (() => void) | undefined): (() => void) | undefined =>
    fn
      ? () => {
          setOpen(false);
          fn();
        }
      : undefined;
  const folded: HomeComputer = {
    ...computer,
    onResize: closeThen(computer.onResize),
    onAllComputers: closeThen(computer.onAllComputers),
    onOpenLook: computer.onOpenLook
      ? (look) => {
          setOpen(false);
          computer.onOpenLook?.(look);
        }
      : undefined,
    power: computer.power
      ? {
          ...computer.power,
          onPower: (action) => {
            if (action === "sleep" || action === "stop") setOpen(false);
            computer.power?.onPower(action);
          },
        }
      : null,
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid="home-computer-pill"
            className="flex h-8 min-w-0 items-center gap-2.5 rounded-full border border-border/70 bg-card/60 pr-2.5 pl-3 text-xs transition-colors hover:bg-accent/60"
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                computer.lowResource && state === "on" ? "bg-warning" : POWER_DOT[state],
              )}
              aria-hidden
            />
            <span className="max-w-40 truncate font-medium">{computer.name}</span>
            {computer.boosted ? (
              <ZapIcon
                className="size-3 shrink-0 fill-amber-400 text-amber-500"
                aria-label="Boosted"
              />
            ) : null}
            {state === "on" ? (
              <>
                <MiniMeter label="CPU" pct={pct.cpu} />
                <MiniMeter label="RAM" pct={pct.mem} />
                <MiniMeter label="Disk" pct={pct.disk} />
              </>
            ) : (
              <span className="text-muted-foreground">{POWER_STATE_LABEL[state]}</span>
            )}
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <PopoverPopup align="end" className="w-[380px]">
        <ComputerDetails computer={folded} />
      </PopoverPopup>
    </Popover>
  );
}

/** The old hero, folded: name, size, live load, power, boost, resize, the ways deeper. */
export function ComputerDetails({
  computer,
  compact = false,
}: {
  computer: HomeComputer;
  /** The widget: no address, no Turn off, no links. */
  compact?: boolean;
}) {
  const state = powerStateOf(computer);
  const load = computer.load;
  const pct = loadPercents(load);
  const busy = computer.power?.pendingAction != null || state === "busy";
  const powerButton = (action: PowerAction, label: string, icon: ReactNode, primary = false) => (
    <Button
      size="xs"
      variant={primary ? "default" : "outline"}
      disabled={busy}
      onClick={() => computer.power?.onPower(action)}
    >
      {computer.power?.pendingAction === action ? <Spinner className="size-3" /> : icon}
      {label}
    </Button>
  );
  const rows: Array<{ look: ResourceLook; icon: ReactNode; pct: number; value: string }> = [
    {
      look: "cpu",
      icon: <CpuIcon />,
      pct: pct.cpu ?? 0,
      value: pct.cpu !== null ? `${pct.cpu}%` : "—",
    },
    {
      look: "memory",
      icon: <MemoryStickIcon />,
      pct: pct.mem ?? 0,
      value:
        load?.memUsedMb != null
          ? `${formatMemory(load.memUsedMb)}${load.memTotalMb ? ` of ${formatMemory(load.memTotalMb)}` : ""}`
          : "—",
    },
    {
      look: "disk",
      icon: <HardDriveIcon />,
      pct: pct.disk ?? 0,
      value:
        load?.diskUsedGb != null
          ? `${formatGb(load.diskUsedGb)}${load.diskTotalGb ? ` of ${formatGb(load.diskTotalGb)}` : ""}`
          : "—",
    },
  ];

  return (
    <div className="flex flex-col gap-3" data-testid="home-computer-details">
      <div className="flex items-start gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MonitorIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{computer.name}</span>
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", POWER_DOT[state])} aria-hidden />
              {POWER_STATE_LABEL[state]}
            </span>
          </div>
          {computer.subtitle ? (
            <div className="text-xs text-muted-foreground">{computer.subtitle}</div>
          ) : null}
          {computer.address && !compact ? (
            <a
              href={computer.address}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
              title={computer.address}
            >
              <GlobeIcon className="size-3 shrink-0" />
              <span className="truncate">{displayAddress(computer.address)}</span>
            </a>
          ) : null}
        </div>
      </div>

      {state === "on" ? (
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1 text-xs">
          {rows.map((row) => (
            <button
              key={row.look}
              type="button"
              disabled={!computer.onOpenLook}
              onClick={() => computer.onOpenLook?.(row.look)}
              className="col-span-3 -mx-1 grid grid-cols-subgrid items-center rounded-md px-1 py-1 text-left transition-colors enabled:hover:bg-accent/60 [&>svg]:size-3.5 [&>svg]:text-muted-foreground"
            >
              {row.icon}
              <Meter value={row.pct} />
              <span className="min-w-20 text-right tabular-nums text-muted-foreground">
                {row.value}
              </span>
            </button>
          ))}
        </div>
      ) : state === "asleep" ? (
        <p className="text-xs text-muted-foreground">
          Asleep — nothing is running, so there is nothing to measure.
        </p>
      ) : null}

      {computer.lowResource && state === "on" ? (
        <p
          className="flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-2 text-xs ring-1 ring-warning/30"
          role="status"
        >
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
          {computer.lowResource === "memory"
            ? "Running low on memory — programs may slow down or stop."
            : "The disk is almost full — new files and apps may not fit."}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {state === "on" || computer.boosted ? computer.boost : null}
        {state === "on" && computer.onResize ? (
          <Button size="xs" variant="outline" onClick={computer.onResize}>
            <PlusIcon />
            Memory / cores
          </Button>
        ) : null}
        {computer.power ? (
          state === "on" ? (
            <>
              {powerButton("sleep", "Sleep", <MoonIcon />)}
              {compact ? null : powerButton("stop", "Turn off", <PowerIcon />)}
            </>
          ) : state === "asleep" ? (
            powerButton("wake", "Wake up", <SunIcon />, true)
          ) : state === "off" ? (
            powerButton("start", "Turn on", <PowerIcon />, true)
          ) : null
        ) : null}
      </div>
      {computer.power?.error ? (
        <p className="text-xs text-destructive" role="alert">
          {computer.power.error}
        </p>
      ) : null}

      {compact ? null : (
        <div className="-mx-1 flex flex-col border-t border-border/60 pt-2">
          {computer.onOpenLook ? (
            <LinkRow icon={<CpuIcon />} onClick={() => computer.onOpenLook?.("cpu")}>
              What's using my computer
            </LinkRow>
          ) : null}
          {computer.onAllComputers ? (
            <LinkRow icon={<LayoutGridIcon />} onClick={computer.onAllComputers}>
              All my computers
            </LinkRow>
          ) : null}
        </div>
      )}
    </div>
  );
}

function LinkRow({
  icon,
  children,
  onClick,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
    >
      {icon}
      <span className="flex-1">{children}</span>
      <ChevronRightIcon />
    </button>
  );
}
