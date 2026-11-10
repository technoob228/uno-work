/** Small shared parts of the workspace screens: state dots, kind icons, the "used by" chips. */
import {
  CloudIcon,
  CpuIcon,
  DatabaseIcon,
  GitBranchIcon,
  GlobeIcon,
  HardDriveIcon,
  KeyRoundIcon,
  LaptopIcon,
  ZapIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "../lib/utils";
import type { ComputerState, PartKind, WsComputer } from "./model";

export const STATE_DOT: Readonly<Record<ComputerState, string>> = {
  running: "bg-success",
  waking: "animate-pulse bg-warning",
  asleep: "bg-info/70",
  offline: "bg-muted-foreground/40",
};

export function StateDot({ state, className }: { state: ComputerState; className?: string }) {
  return (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATE_DOT[state], className)} />
  );
}

export const PART_ICON: Readonly<Record<PartKind, ComponentType<{ className?: string }>>> = {
  spark: ZapIcon,
  database: DatabaseIcon,
  kv: KeyRoundIcon,
  drive: HardDriveIcon,
  git: GitBranchIcon,
  address: GlobeIcon,
};

export function ComputerGlyph({
  computer,
  className,
}: {
  computer: Pick<WsComputer, "kind" | "detail">;
  className?: string;
}) {
  const Icon =
    computer.kind === "cloud" ? CloudIcon : /Pi\b/.test(computer.detail) ? CpuIcon : LaptopIcon;
  return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

/** A tiny pill: an app or an assistant that uses this piece of hardware. */
export function UsedByChip({ icon, name }: { icon?: string; name: string }) {
  return (
    <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-muted/70 px-1.5 text-[11px] text-foreground/80">
      {icon ? (
        <span aria-hidden className="text-[10px] leading-none">
          {icon}
        </span>
      ) : null}
      <span className="max-w-28 truncate">{name}</span>
    </span>
  );
}
