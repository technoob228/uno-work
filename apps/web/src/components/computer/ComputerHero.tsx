/**
 * The top of the desktop: which computer this is, whether it is on, how hard
 * it is working right now (processor, memory, disk — live, compact), its
 * address, and the power buttons in the strategy's words: Sleep, Wake up,
 * Turn off, Turn on.
 *
 * Works for a cloud computer (a box) and for the machine Uno Work runs on when
 * that is not a box (a laptop): then there is no power and no address, only
 * the name and the load.
 */
import {
  ChevronRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  PowerIcon,
  SunIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  POWER_STATE_LABEL,
  computerPowerState,
  displayAddress,
  formatGb,
  formatMemory,
  percent,
} from "./computerFormat";
import { CopyButton, Meter } from "./computerUi";
import { EconomyChip } from "./EconomyControl";
import type { UnoComputerEconomy } from "@t3tools/contracts";
import type { ResourceLook } from "./resources/resourceModel";

export type PowerAction = "sleep" | "wake" | "stop" | "start";
type PowerState = ReturnType<typeof computerPowerState>;

export const POWER_DOT: Record<PowerState, string> = {
  on: "bg-success",
  asleep: "bg-info",
  off: "bg-muted-foreground/50",
  busy: "animate-pulse bg-warning",
  unknown: "bg-muted-foreground/50",
};

/** The load, whichever way it was read (the daemon's OS or the control plane). */
export interface ComputerLoad {
  readonly cpuPct: number | null;
  readonly memUsedMb: number | null;
  readonly memTotalMb: number | null;
  readonly diskUsedGb: number | null;
  readonly diskTotalGb: number | null;
}

function confirmCopy(action: "sleep" | "stop", own: boolean) {
  if (action === "sleep") {
    return {
      title: "Put your computer to sleep?",
      body:
        "Your files and apps stay exactly where they are, and you don't pay for running time while it sleeps." +
        (own
          ? " This screen runs on the computer itself, so it will disconnect. Wake it up again from the Uno console."
          : ""),
      confirm: "Sleep",
    };
  }
  return {
    title: "Turn your computer off?",
    body:
      "It shuts down completely and stops answering at its address. Everything on its disk is kept." +
      (own
        ? " This screen runs on the computer itself, so it will disconnect — turn it back on from the Uno console."
        : " You can turn it back on at any time."),
    confirm: "Turn off",
  };
}

export function ComputerHero({
  name,
  subtitle,
  status,
  address,
  own,
  load,
  loadLive,
  power,
  onResize,
  lowResource,
  onOpenLook,
  boost,
  economy,
}: {
  name: string;
  subtitle: string | null;
  /** Control-plane status; null for a machine that is simply on (a laptop). */
  status: string | null;
  address: string | null;
  own: boolean;
  load: ComputerLoad | null;
  loadLive: boolean;
  power: {
    readonly pendingAction: PowerAction | null;
    readonly error: string | null;
    readonly onPower: (action: PowerAction) => void;
  } | null;
  /** Opens "Add memory / cores"; absent when this computer can't be resized from here. */
  onResize?: (() => void) | undefined;
  /** Steadily short of memory or disk: say so, next to the button that fixes it. */
  lowResource?: "memory" | "disk" | null | undefined;
  /** Opens "What's using your computer" at a tile; absent when there's nothing to drill into. */
  onOpenLook?: ((look: ResourceLook) => void) | undefined;
  /** "Boost ×2 for 1 hour" (or the boosted pill); absent when boost isn't offered. */
  boost?: React.ReactNode;
  /** Economy mode: a small "Economy · awake" chip next to the power state. */
  economy?: UnoComputerEconomy | undefined;
}) {
  const state: PowerState = status === null ? "on" : computerPowerState(status);
  const [confirm, setConfirm] = useState<"sleep" | "stop" | null>(null);

  const powerButton = (
    action: PowerAction,
    label: string,
    icon: React.ReactNode,
    primary = false,
  ) => (
    <Button
      size="sm"
      variant={primary ? "default" : "outline"}
      disabled={power?.pendingAction != null || state === "busy"}
      onClick={() =>
        action === "sleep" || action === "stop" ? setConfirm(action) : power?.onPower(action)
      }
    >
      {power?.pendingAction === action ? <Spinner className="size-3.5" /> : icon}
      {label}
    </Button>
  );

  return (
    <section className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-b from-primary/[0.06] to-card/40 p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-inner">
          <MonitorIcon className="size-6" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">{name}</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-2.5 py-0.5 text-xs font-medium ring-1 ring-border">
              <span className={cn("size-1.5 rounded-full", POWER_DOT[state])} aria-hidden />
              {POWER_STATE_LABEL[state]}
            </span>
            <EconomyChip economy={economy} />
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {subtitle ? <span>{subtitle}</span> : null}
            {address ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <GlobeIcon className="size-3 shrink-0" />
                <a
                  href={address}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate font-mono hover:text-foreground hover:underline"
                  title={address}
                >
                  {displayAddress(address)}
                </a>
                <ExternalLinkIcon className="size-3 shrink-0" />
                <CopyButton value={address} label="address" />
              </span>
            ) : null}
          </div>
        </div>

        {power ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {state === "on" ? (
              <>
                {powerButton("sleep", "Sleep", <MoonIcon />)}
                {powerButton("stop", "Turn off", <PowerIcon />)}
              </>
            ) : state === "asleep" ? (
              powerButton("wake", "Wake up", <SunIcon />, true)
            ) : state === "off" ? (
              powerButton("start", "Turn on", <PowerIcon />, true)
            ) : null}
          </div>
        ) : null}
      </div>

      <LoadStrip
        load={load}
        live={loadLive && state === "on"}
        asleep={state !== "on"}
        onOpenLook={onOpenLook}
      />

      {(onResize && state === "on") || boost ? (
        <div
          className={cn(
            "mt-4 flex flex-wrap items-center gap-3",
            lowResource &&
              onResize &&
              state === "on" &&
              "rounded-2xl bg-warning/10 px-3 py-2 ring-1 ring-warning/30",
          )}
        >
          {lowResource && onResize && state === "on" ? (
            <p className="flex min-w-0 flex-1 items-center gap-2 text-xs" role="status">
              <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" />
              {lowResource === "memory"
                ? "Your computer is running low on memory — programs may slow down or stop."
                : "Your computer's disk is almost full — new files and apps may not fit."}
              {onOpenLook ? (
                <button
                  type="button"
                  className="shrink-0 text-primary underline-offset-4 hover:underline"
                  onClick={() => onOpenLook(lowResource)}
                >
                  {lowResource === "memory" ? "See what's using it" : "See what takes the space"}
                </button>
              ) : null}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          {boost}
          {onResize && state === "on" ? (
            <Button size="sm" variant={lowResource ? "default" : "outline"} onClick={onResize}>
              <PlusIcon />
              {lowResource === "disk"
                ? "Add disk space"
                : lowResource === "memory"
                  ? "Add memory"
                  : "Add memory / cores"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {power?.error ? (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {power.error}
        </p>
      ) : null}

      <PowerConfirmDialog
        confirm={confirm}
        own={own}
        onCancel={() => setConfirm(null)}
        onConfirm={(action) => {
          power?.onPower(action);
          setConfirm(null);
        }}
      />
    </section>
  );
}

/** "Put your computer to sleep?" / "Turn your computer off?" — asked before either. */
export function PowerConfirmDialog({
  confirm,
  own,
  onCancel,
  onConfirm,
}: {
  confirm: "sleep" | "stop" | null;
  own: boolean;
  onCancel: () => void;
  onConfirm: (action: "sleep" | "stop") => void;
}) {
  const copy = confirm ? confirmCopy(confirm, own) : null;
  return (
    <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant={confirm === "stop" ? "destructive" : "default"}
            onClick={() => {
              if (confirm) onConfirm(confirm);
            }}
          >
            {copy?.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function LoadStrip({
  load,
  live,
  asleep,
  onOpenLook,
}: {
  load: ComputerLoad | null;
  live: boolean;
  asleep: boolean;
  onOpenLook?: ((look: ResourceLook) => void) | undefined;
}) {
  if (asleep) {
    return (
      <p className="mt-4 text-xs text-muted-foreground">
        Asleep — nothing is running, so there is nothing to measure.
      </p>
    );
  }
  const cpu = load?.cpuPct != null ? Math.round(load.cpuPct) : null;
  const items: Array<{ look: ResourceLook; label: string; value: string; pct: number }> = [
    {
      look: "cpu",
      label: "Processor",
      value: cpu !== null ? `${cpu}%` : "—",
      pct: cpu ?? 0,
    },
    {
      look: "memory",
      label: "Memory",
      value:
        load?.memUsedMb != null
          ? `${formatMemory(load.memUsedMb)}${load.memTotalMb ? ` of ${formatMemory(load.memTotalMb)}` : ""}`
          : "—",
      pct: percent(load?.memUsedMb ?? null, load?.memTotalMb ?? null),
    },
    {
      look: "disk",
      label: "Working disk",
      value:
        load?.diskUsedGb != null
          ? `${formatGb(load.diskUsedGb)}${load.diskTotalGb ? ` of ${formatGb(load.diskTotalGb)}` : ""}`
          : "—",
      pct: percent(load?.diskUsedGb ?? null, load?.diskTotalGb ?? null),
    },
  ];
  const tile = (item: (typeof items)[number]) => (
    <>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {item.label === "Processor" && live ? (
            <span className="size-1.5 animate-pulse rounded-full bg-success" aria-label="live" />
          ) : null}
          {item.label}
          {onOpenLook ? (
            <ChevronRightIcon className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
          ) : null}
        </span>
        <span className="truncate tabular-nums text-foreground">{item.value}</span>
      </div>
      <Meter value={item.pct} />
    </>
  );
  return (
    <div className="mt-5 flex flex-col gap-1.5">
      <div className="grid grid-cols-3 gap-3 sm:gap-5" aria-label="How busy this computer is">
        {items.map((item) =>
          onOpenLook ? (
            <button
              key={item.label}
              type="button"
              onClick={() => onOpenLook(item.look)}
              title={`See what's using the ${item.label.toLowerCase()}`}
              className="group -m-1.5 flex min-w-0 flex-col gap-1.5 rounded-xl p-1.5 text-left outline-hidden transition-colors hover:bg-background/60 focus-visible:ring-2 focus-visible:ring-ring"
            >
              {tile(item)}
            </button>
          ) : (
            <div key={item.label} className="flex min-w-0 flex-col gap-1.5">
              {tile(item)}
            </div>
          ),
        )}
      </div>
      {onOpenLook ? (
        <button
          type="button"
          onClick={() => onOpenLook("cpu")}
          className="self-start text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          What's using my computer?
        </button>
      ) : null}
    </div>
  );
}
