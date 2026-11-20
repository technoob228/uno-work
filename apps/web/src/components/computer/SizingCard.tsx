/**
 * Automatic sizing (Misha 20.11): the computer grows by itself under load —
 * cores and memory, up to 4× its own size, free — and shrinks back when it is
 * quiet. In the computer menu: one quiet line with the size right now; a click
 * opens the card — CPU / Memory / Disk (now, base, up to) and what changed.
 *
 * Shows only when the box carries `sizing` (fishcode internal/box/autosize.go
 * → server unoComputerSizing.ts); every other computer looks as before.
 */
import type { UnoComputerSizing, UnoComputerSizingEvent } from "@t3tools/contracts";
import { ChevronRightIcon, Maximize2Icon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { formatMemory } from "./computerFormat";
import { sizingAmount, sizingNow, sizingPct, sizingWhy, sizingWhen } from "./sizingModel";

export function SizingLine({ sizing }: { sizing: UnoComputerSizing }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-mx-1 flex items-center gap-2 rounded-md px-1 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        data-testid="computer-sizing-line"
      >
        <Maximize2Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          Automatic sizing{sizing.mode === "off" ? " · paused" : ""} · {sizingNow(sizing)}
        </span>
        <ChevronRightIcon className="size-3.5 shrink-0" aria-hidden />
      </button>
      <SizingDialog sizing={sizing} open={open} onOpenChange={setOpen} />
    </>
  );
}

function SizingDialog({
  sizing,
  open,
  onOpenChange,
}: {
  sizing: UnoComputerSizing;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cores = (n: number) => `${n} ${n === 1 ? "core" : "cores"}`;
  const rows = [
    { key: "cpu", label: "CPU", r: sizing.cpu, f: cores, n: (v: number) => String(v) },
    { key: "mem", label: "Memory", r: sizing.memoryMb, f: formatMemory, n: formatMemory },
  ] as const;
  const changes = sizing.history
    .filter((e) => e.applied || e.reason === "node_limit")
    .slice(-6)
    .toReversed();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl" data-testid="computer-sizing-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Automatic sizing
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                sizing.mode === "auto"
                  ? "bg-success/10 text-success"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {sizing.mode === "auto" ? "On" : "Paused"}
            </span>
          </DialogTitle>
          <DialogDescription>
            Grows by itself under load, up to {cores(sizing.cpu.max)} and{" "}
            {formatMemory(sizing.memoryMb.max)} — free. Shrinks back when it’s quiet.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-5">
          <div className="grid grid-cols-3 gap-4">
            {rows.map((row) => (
              <div key={row.key} className="min-w-0">
                <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {row.label}
                </div>
                <div className="text-xl font-bold tabular-nums">{row.f(row.r.current)}</div>
                <div
                  className="relative mt-2 h-1.5 rounded-full bg-muted"
                  role="img"
                  aria-label={`${row.f(row.r.current)} of up to ${row.f(row.r.max)}, base ${row.f(row.r.base)}`}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-500"
                    style={{ width: `${sizingPct(row.r.current, row.r.max)}%` }}
                  />
                  {/* The base: a notch on the scale. */}
                  <span
                    className="absolute -top-0.5 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground/60"
                    style={{ left: `${sizingPct(row.r.base, row.r.max)}%` }}
                  />
                </div>
                <div className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                  base {row.n(row.r.base)} · up to {row.n(row.r.max)}
                </div>
              </div>
            ))}
            <div className="min-w-0">
              <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Disk
              </div>
              <div className="text-xl font-bold tabular-nums">{sizing.diskGb.current} GB</div>
              <div className="mt-3.5 text-xs text-muted-foreground">fixed size</div>
            </div>
          </div>
          {changes.length ? (
            <ol className="flex flex-col gap-1.5 border-t border-border/60 pt-3 text-sm">
              {changes.map((e: UnoComputerSizingEvent) => (
                <li key={e.seq} className="grid grid-cols-[5.5rem_auto_1fr] items-baseline gap-3">
                  <time className="text-xs text-muted-foreground tabular-nums" dateTime={e.at}>
                    {sizingWhen(e.at)}
                  </time>
                  <span className="font-medium tabular-nums">
                    {e.resource === "cpu" ? "CPU" : "Memory"}{" "}
                    {e.from !== e.to
                      ? `${sizingAmount(e, e.from)} → ${sizingAmount(e, e.to)}`
                      : sizingAmount(e, e.to)}
                  </span>
                  <span
                    className={cn(
                      "text-xs",
                      e.reason === "node_limit" ? "text-warning" : "text-muted-foreground",
                    )}
                  >
                    {sizingWhy(e.reason)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">No changes yet — it is at its own size.</p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
