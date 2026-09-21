/**
 * Human wording for the "This computer" screen. Pure functions so the words
 * are tested without rendering: the screen speaks about a computer ("on",
 * "asleep", "awake for 3 days"), never about a box, instance or VM.
 */
import type { UnoComputerBox, UnoComputerMetricsPoint } from "@t3tools/contracts";

export type ComputerPowerState = "on" | "asleep" | "off" | "busy" | "unknown";

export function computerPowerState(status: string | null | undefined): ComputerPowerState {
  switch (status) {
    case "running":
      return "on";
    case "sleeping":
    case "suspended":
    case "paused":
      return "asleep";
    case "stopped":
    case "archived":
      return "off";
    case "starting":
    case "waking":
    case "provisioning":
    case "creating":
    case "stopping":
    case "sleeping_pending":
      return "busy";
    default:
      return "unknown";
  }
}

export const POWER_STATE_LABEL: Record<ComputerPowerState, string> = {
  on: "On",
  asleep: "Asleep",
  off: "Off",
  busy: "Changing…",
  unknown: "Unknown",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** 90061 → "1 day", 7200 → "2 hours", 125 → "2 minutes". Only the largest unit. */
export function humanDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  if (days >= 1) return plural(days, "day");
  const hours = Math.floor(s / 3_600);
  if (hours >= 1) return plural(hours, "hour");
  const minutes = Math.max(1, Math.floor(s / 60));
  return plural(minutes, "minute");
}

/** "awake for 3 days" — only when the control plane said when it woke. */
export function awakeLine(
  box: Pick<UnoComputerBox, "status" | "startedAt">,
  now: number = Date.now(),
): string | null {
  const state = computerPowerState(box.status);
  if (state === "asleep") return "wakes up when you need it";
  if (state !== "on" || !box.startedAt) return null;
  const started = Date.parse(box.startedAt);
  if (!Number.isFinite(started)) return null;
  const seconds = (now - started) / 1000;
  if (seconds < 90) return "just woke up";
  return `awake for ${humanDuration(seconds)}`;
}

export function formatMemory(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

export function formatGb(gb: number): string {
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** "2 GB memory · 2 cores · 30 GB disk" — sizes that are unknown (0) are left out. */
export function sizeLine(box: Pick<UnoComputerBox, "ramMb" | "vcpu" | "diskGb">): string {
  const parts: string[] = [];
  if (box.ramMb > 0) parts.push(`${formatMemory(box.ramMb)} memory`);
  if (box.vcpu > 0) parts.push(plural(box.vcpu, "core"));
  if (box.diskGb > 0) parts.push(`${formatGb(box.diskGb)} disk`);
  return parts.join(" · ");
}

export function percent(used: number | null, total: number | null): number {
  if (used === null || total === null || total <= 0) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

/** `http://1.2.3.4:40180` → `1.2.3.4:40180` for display. */
export function displayAddress(address: string): string {
  return address.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * SVG path for a filled sparkline of CPU %, in a `width × height` box.
 * Empty string for fewer than two points — a single dot is not a trend.
 */
export function sparklinePath(
  points: ReadonlyArray<UnoComputerMetricsPoint>,
  width: number,
  height: number,
): { line: string; area: string } {
  if (points.length < 2) return { line: "", area: "" };
  const step = width / (points.length - 1);
  const coords = points.map((point, index) => {
    const value = Math.max(0, Math.min(100, point.cpuPct));
    const x = index * step;
    const y = height - (value / 100) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${coords.join(" L")}`;
  return { line, area: `${line} L${width},${height} L0,${height} Z` };
}
