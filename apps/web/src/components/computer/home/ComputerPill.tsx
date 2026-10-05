/**
 * The computer, folded into one line in Home's header: is it on, how busy it
 * is (three tiny meters), boosted or not, a faint leaf when economy is on.
 * A click opens the computer menu — the one place for "which computer":
 *
 *   - this computer: size, live load with values, Boost, "Memory / cores",
 *     Sleep / Turn off / Wake up;
 *   - two quiet lines: economy (with "How it works") and Boost hours left
 *     (and what economy earned);
 *   - "What's using my computer";
 *   - the other computers to switch to, "All computers", "Add computer"
 *     (this used to be a separate switcher at the top of the sidebar).
 *
 * The same details (compact) make the "This computer" widget.
 *
 * The chat header shows the same chip (`fit="chat"`, via `ComputerChip`) so the
 * computer can be switched from any screen; there it folds to a monitor icon
 * and the dot when the header is narrow, and the menu still opens.
 *
 * The chip is also where the connection is said — quietly (05.10, instead of
 * a toast on every reconnect): nothing while it's fine or for a short drop,
 * then "Reconnecting…" / "Offline — retrying" / "Asleep" in place of "On";
 * an amber dot and one action in the menu only when the person is needed
 * ("No connection" → Retry, "Sign in"). The menu's first line is always the
 * truth: "Connected", "Reconnecting…", "Offline — retrying · synced 2 min ago".
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CpuIcon,
  GlobeIcon,
  HardDriveIcon,
  LayoutGridIcon,
  LeafIcon,
  MemoryStickIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  PowerIcon,
  SunIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useDevMode } from "../../../devMode";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import {
  ComputerSwitcherDialogs,
  ComputerSwitcherList,
} from "../../computerSwitcher/ComputerSwitcherList";
import { useComputerSwitcher } from "../../computerSwitcher/useComputerSwitcher";
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
import { CONNECTION_ACTION_LABEL, CONNECTION_DOT } from "./connectionStatus";
import { type ComputerConnection, useComputerConnection } from "./useComputerConnection";

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
  /** Economy is on: a faint leaf on the pill. */
  readonly economyOn?: boolean | undefined;
  /** `<EconomyLine />` for the menu; null when economy isn't offered. */
  readonly economy?: ReactNode;
  /** "Boost: 7 h left this month (+1.8 h earned by economy)"; null when no boost hours. */
  readonly boostSummary?: string | null | undefined;
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

/**
 * Where the chip sits. Home's header has room: name and meters from `md`.
 * The chat header is shared with the chat's own actions: below a roomy header
 * (its `header-actions` container) the chip is just an icon and the dot.
 */
export type ComputerPillFit = "home" | "chat";

const FIT: Record<
  ComputerPillFit,
  {
    readonly button: string;
    readonly icon: string;
    readonly detail: string;
    readonly meter: string;
  }
> = {
  home: {
    button: "h-8 gap-2.5 pr-2.5 pl-3",
    icon: "hidden",
    detail: "",
    meter: "md:flex",
  },
  chat: {
    button: "h-7 gap-1.5 px-2 sm:h-6 @3xl/header-actions:gap-2 @3xl/header-actions:pl-2.5",
    icon: "",
    detail: "hidden @3xl/header-actions:inline",
    meter: "@6xl/header-actions:flex",
  },
};

function MiniMeter({
  label,
  pct,
  className,
}: {
  label: string;
  pct: number | null;
  className: string;
}) {
  return (
    <span
      className={cn("hidden items-center gap-1.5 text-[11px] text-muted-foreground", className)}
    >
      {label}
      <Meter value={pct ?? 0} className="h-1 w-8" />
    </span>
  );
}

interface ComputerPillProps {
  computer: HomeComputer | null;
  loading: boolean;
  fit?: ComputerPillFit;
  /**
   * Whose connection the chip tells (`null` — the browser's own computer).
   * Left out, the chip says nothing about the connection.
   */
  environmentId?: EnvironmentId | null;
  /** A fixed connection instead of the live one (tests, previews). */
  connection?: ComputerConnection | null;
}

export function ComputerPill(props: ComputerPillProps) {
  if (props.connection !== undefined || props.environmentId === undefined) {
    return <ComputerPillView {...props} connection={props.connection ?? null} />;
  }
  return <LiveComputerPill {...props} environmentId={props.environmentId} />;
}

function LiveComputerPill(props: ComputerPillProps & { environmentId: EnvironmentId | null }) {
  const connection = useComputerConnection(props.environmentId);
  return <ComputerPillView {...props} connection={connection} />;
}

function ComputerPillView({
  computer,
  loading,
  fit = "home",
  connection,
}: ComputerPillProps & { connection: ComputerConnection | null }) {
  const [open, setOpen] = useState(false);
  const switcher = useComputerSwitcher(() => setOpen(false));
  const look = FIT[fit];
  // 01.10: on the start screen the pill is the name, on/asleep and "Details";
  // the meters, boost and economy marks are for Dev mode (all of it is in the menu).
  const simple = !useDevMode() && fit === "home";
  if (loading) {
    return (
      <Skeleton
        className={cn(
          "rounded-full",
          fit === "home" ? "h-8 w-56" : "h-7 w-10 sm:h-6 @3xl/header-actions:w-32",
        )}
      />
    );
  }
  // Can't read this computer right now: the menu still switches computers.
  const state = computer ? powerStateOf(computer) : "unknown";
  const pct = loadPercents(computer?.load ?? null);
  // Dialogs (resize, sleep) outlive the popover: close it as they open.
  const closeThen = (fn: (() => void) | undefined): (() => void) | undefined =>
    fn
      ? () => {
          setOpen(false);
          fn();
        }
      : undefined;
  const folded: HomeComputer | null = computer
    ? {
        ...computer,
        onResize: closeThen(computer.onResize),
        // The switcher below has "All computers, sites and plan".
        onAllComputers: undefined,
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
      }
    : null;
  const name = computer?.name ?? switcher.current?.name ?? "This computer";
  // The connection, when it has something to say (null — it's fine).
  const talking = connection && connection.status.kind !== "connected" ? connection.status : null;
  const said = talking?.chip ?? null;
  const saidNode = said ? (
    <span
      className={cn(
        "truncate",
        talking?.attention ? "font-medium text-warning-foreground" : "text-muted-foreground",
        // Folded in a narrow chat header, only what needs the person still speaks.
        talking?.attention ? "" : look.detail,
      )}
      data-testid="computer-connection-chip"
    >
      {said}
    </span>
  ) : null;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid={fit === "home" ? "home-computer-pill" : "chat-computer-chip"}
              aria-label={`${name} — ${said ? `${said}, ` : ""}computer menu`}
              title={fit === "chat" ? (talking ? `${name} · ${talking.line}` : name) : undefined}
              className={cn(
                "flex min-w-0 shrink-0 items-center rounded-full border border-border/70 bg-card/60 text-xs transition-colors outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                look.button,
              )}
            >
              <MonitorIcon
                className={cn("size-3.5 shrink-0 text-muted-foreground", look.icon)}
                aria-hidden
              />
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  // A drop inside the grace period changes nothing on the chip, the dot included.
                  (talking && said ? CONNECTION_DOT[talking.kind] : undefined) ??
                    (computer?.lowResource && state === "on" ? "bg-warning" : POWER_DOT[state]),
                )}
                aria-hidden
              />
              <span
                className={cn(
                  "truncate font-medium",
                  fit === "home" ? "max-w-40" : "max-w-32",
                  look.detail,
                )}
              >
                {name}
              </span>
              {computer?.boosted && !simple ? (
                <ZapIcon
                  className={cn("size-3 shrink-0 fill-amber-400 text-amber-500", look.detail)}
                  aria-label="Boosted"
                />
              ) : null}
              {computer?.economyOn && !simple ? (
                <LeafIcon
                  className={cn("size-3 shrink-0 text-muted-foreground/70", look.detail)}
                  aria-label="Economy on"
                />
              ) : null}
              {simple ? (
                <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
                  {saidNode ?? (computer ? <span>{POWER_STATE_LABEL[state]}</span> : null)}
                  {saidNode || computer ? <span aria-hidden>·</span> : null}
                  <span className="text-foreground/80">Details</span>
                </span>
              ) : saidNode ? (
                saidNode
              ) : !computer ? null : state === "on" ? (
                <>
                  <MiniMeter label="CPU" pct={pct.cpu} className={look.meter} />
                  <MiniMeter label="RAM" pct={pct.mem} className={look.meter} />
                  <MiniMeter label="Disk" pct={pct.disk} className={look.meter} />
                </>
              ) : (
                <span className={cn("text-muted-foreground", look.detail)}>
                  {POWER_STATE_LABEL[state]}
                </span>
              )}
              <ChevronDownIcon
                className={cn("size-3.5 shrink-0 text-muted-foreground", look.detail)}
              />
            </button>
          }
        />
        <PopoverPopup
          align="end"
          className="max-h-[min(85vh,720px)] w-[min(380px,calc(100vw-1.5rem))] overflow-y-auto"
        >
          <div className="flex flex-col gap-3">
            {connection ? <ConnectionLine connection={connection} /> : null}
            {folded ? <ComputerDetails computer={folded} /> : null}
            <section
              aria-label="Switch computer"
              className={cn("-mx-1 flex flex-col", folded && "border-t border-border/60 pt-2")}
            >
              <ComputerSwitcherList switcher={switcher} />
            </section>
          </div>
        </PopoverPopup>
      </Popover>
      <ComputerSwitcherDialogs switcher={switcher} />
    </>
  );
}

/** The menu's first line: how the connection is, and its one action when there is one. */
function ConnectionLine({ connection }: { connection: ComputerConnection }) {
  const { status, act, acting } = connection;
  return (
    <div
      className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground"
      role="status"
      data-testid="computer-connection-line"
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          CONNECTION_DOT[status.kind] ?? "bg-success",
        )}
        aria-hidden
      />
      <span className={cn("min-w-0 flex-1", status.attention && "text-foreground")}>
        {status.line}
      </span>
      {act && status.action ? (
        <Button
          size="xs"
          variant={status.attention ? "default" : "outline"}
          disabled={acting}
          onClick={act}
        >
          {acting ? <Spinner className="size-3" /> : null}
          {CONNECTION_ACTION_LABEL[status.action]}
        </Button>
      ) : null}
    </div>
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

      {!compact && (computer.economy || computer.boostSummary) ? (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2.5">
          {computer.economy}
          {computer.boostSummary ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <ZapIcon className="size-3.5 shrink-0" aria-hidden />
              {computer.boostSummary}
            </p>
          ) : null}
        </div>
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
