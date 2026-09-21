/**
 * The top of "This computer": which computer this is, whether it is on, how
 * big it is, how long it has been awake, and its address on the internet.
 * Power buttons live here, in the words the strategy uses: Sleep, Wake up,
 * Turn off, Turn on.
 */
import type { UnoComputerBox } from "@t3tools/contracts";
import {
  ExternalLinkIcon,
  GlobeIcon,
  MonitorIcon,
  MoonIcon,
  PowerIcon,
  SunIcon,
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
  awakeLine,
  computerPowerState,
  displayAddress,
  sizeLine,
} from "./computerFormat";
import { CopyButton } from "./computerUi";

type PowerAction = "sleep" | "wake" | "stop" | "start";

const DOT: Record<ReturnType<typeof computerPowerState>, string> = {
  on: "bg-success",
  asleep: "bg-info",
  off: "bg-muted-foreground/50",
  busy: "animate-pulse bg-warning",
  unknown: "bg-muted-foreground/50",
};

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
  box,
  own,
  pendingAction,
  powerError,
  onPower,
}: {
  box: UnoComputerBox;
  own: boolean;
  pendingAction: PowerAction | null;
  powerError: string | null;
  onPower: (action: PowerAction) => void;
}) {
  const state = computerPowerState(box.status);
  const awake = awakeLine(box);
  const size = sizeLine(box);
  const [confirm, setConfirm] = useState<"sleep" | "stop" | null>(null);
  const copy = confirm ? confirmCopy(confirm, own) : null;

  const powerButton = (
    action: PowerAction,
    label: string,
    icon: React.ReactNode,
    primary = false,
  ) => (
    <Button
      size="sm"
      variant={primary ? "default" : "outline"}
      disabled={pendingAction !== null || state === "busy"}
      onClick={() =>
        action === "sleep" || action === "stop" ? setConfirm(action) : onPower(action)
      }
    >
      {pendingAction === action ? <Spinner className="size-3.5" /> : icon}
      {label}
    </Button>
  );

  return (
    <section className="relative overflow-hidden rounded-3xl border border-border/60 bg-gradient-to-b from-primary/[0.06] to-card/40 p-6 sm:p-7">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <div className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-inner">
          <MonitorIcon className="size-8" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{box.name}</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-background/70 px-2.5 py-0.5 text-xs font-medium ring-1 ring-border">
              <span className={cn("size-1.5 rounded-full", DOT[state])} aria-hidden />
              {POWER_STATE_LABEL[state]}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {[size, awake].filter(Boolean).join(" · ") || "Your computer in the Uno cloud"}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {box.address ? (
              <div className="flex min-w-0 items-center gap-1 rounded-xl bg-background/70 py-1 pr-1 pl-3 ring-1 ring-border">
                <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs" title={box.address}>
                  {displayAddress(box.address)}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  render={<a href={box.address} target="_blank" rel="noopener noreferrer" />}
                >
                  <ExternalLinkIcon />
                  Open
                </Button>
                <CopyButton value={box.address} label="address" />
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                No address on the internet yet — install an app and it gets one.
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-stretch">
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
      </div>

      {powerError ? (
        <p className="mt-4 text-xs text-destructive" role="alert">
          {powerError}
        </p>
      ) : null}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
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
                if (confirm) onPower(confirm);
                setConfirm(null);
              }}
            >
              {copy?.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
