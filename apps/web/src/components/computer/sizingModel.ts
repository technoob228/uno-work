/** Words and numbers of the Automatic sizing card (SizingCard.tsx). */
import type { UnoComputerSizing, UnoComputerSizingEvent } from "@t3tools/contracts";

import { formatMemory } from "./computerFormat";

const cores = (n: number) => `${n} ${n === 1 ? "core" : "cores"}`;

/** "6 cores · 6 GB" — the size right now. */
export function sizingNow(s: UnoComputerSizing): string {
  return `${cores(s.cpu.current)} · ${formatMemory(s.memoryMb.current)}`;
}

export function sizingAmount(e: UnoComputerSizingEvent, v: number): string {
  return e.resource === "cpu" ? cores(v) : formatMemory(v);
}

export function sizingPct(v: number, max: number): number {
  return max > 0 ? Math.min(100, Math.max(0, (v / max) * 100)) : 0;
}

const WHY: Record<string, string> = {
  pressure: "under load",
  idle: "quiet again",
  node_limit: "wanted more, the server is busy — trying again",
  manual: "set by hand",
};

export function sizingWhy(reason: string): string {
  return WHY[reason] ?? reason;
}

/** "just now", "41 min ago", "3 h ago", then the date. */
export function sizingWhen(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const min = Math.round((now - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
