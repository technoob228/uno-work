/**
 * The words and rules of "What's using your computer", kept free of React so
 * they are tested directly: sizes a person reads, hints when something runs
 * short (and who is to blame), which chat an agent belongs to, and the note
 * handed to Uno when the person asks it to look.
 */
import type {
  UnoComputerResources,
  UnoDiskUsage,
  UnoResourceGroup,
  UnoResourcesMemory,
} from "@t3tools/contracts";

export type ResourceLook = "cpu" | "memory" | "disk" | "network";

export const RESOURCE_LOOKS: ReadonlyArray<ResourceLook> = ["cpu", "memory", "disk", "network"];

export function parseResourceLook(value: unknown): ResourceLook | undefined {
  return typeof value === "string" && (RESOURCE_LOOKS as ReadonlyArray<string>).includes(value)
    ? (value as ResourceLook)
    : undefined;
}

/** 1536 → "1.5 KB"; 3.2e9 → "3.0 GB". Binary units, the way computers count disk. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit >= 3 || (unit > 0 && value < 10) ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatMb(mb: number): string {
  return formatBytes(mb * 1024 * 1024);
}

/** Bytes per second → "1.2 MB/s". */
export function formatRate(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return "—";
  return `${formatBytes(bps)}/s`;
}

export function formatPct(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** Parts of the memory bar, in percent of all memory (they add up to 100). */
export function memoryBar(memory: UnoResourcesMemory): {
  usedPct: number;
  cachePct: number;
  freePct: number;
} {
  if (memory.totalMb <= 0) return { usedPct: 0, cachePct: 0, freePct: 100 };
  const used = Math.min(100, (memory.usedMb / memory.totalMb) * 100);
  const cache = Math.min(100 - used, (memory.cacheMb / memory.totalMb) * 100);
  return { usedPct: used, cachePct: cache, freePct: Math.max(0, 100 - used - cache) };
}

/** How full memory really is: what programs hold, not the cache that is given back. */
export function memoryPressurePct(memory: UnoResourcesMemory): number {
  if (memory.totalMb <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - memory.availableMb / memory.totalMb) * 100));
}

export const MEMORY_TIGHT_PCT = 85;
export const CPU_BUSY_PCT = 85;
export const DISK_FULL_PCT = 90;

export interface ResourceTip {
  readonly look: ResourceLook;
  readonly title: string;
  readonly body: string;
  /** The group the tip is about — its row gets the buttons. */
  readonly groupId: string | null;
  /** Adding memory / cores / disk would help. */
  readonly suggestResize: boolean;
}

function heaviest(
  groups: ReadonlyArray<UnoResourceGroup>,
  by: "cpu" | "memory",
): UnoResourceGroup | null {
  const sorted = groups
    .filter((g) => g.kind !== "system")
    .toSorted((a, b) => (by === "cpu" ? b.cpuPct - a.cpuPct : b.memMb - a.memMb));
  return sorted[0] ?? null;
}

/** Hints for what is short right now, most urgent first. */
export function resourceTips(
  resources: UnoComputerResources,
  disk: UnoDiskUsage | null = null,
): ResourceTip[] {
  const tips: ResourceTip[] = [];
  const memPct = memoryPressurePct(resources.memory);
  if (memPct >= MEMORY_TIGHT_PCT) {
    const top = heaviest(resources.groups, "memory");
    const swapNote =
      resources.memory.swapUsedMb > 256
        ? " It has started to use the disk as memory (swap), which slows everything down."
        : "";
    tips.push({
      look: "memory",
      title: "Memory is almost full",
      body:
        (top
          ? `${top.name} uses the most — ${formatMb(top.memMb)}. Stopping it frees memory right away.`
          : "Programs hold almost all of it.") + swapNote,
      groupId: top?.id ?? null,
      suggestResize: true,
    });
  }
  const recent = resources.history.slice(-6).map((p) => p.cpuPct ?? 0);
  const cpuBusy =
    recent.length >= 3
      ? recent.reduce((a, b) => a + b, 0) / recent.length >= CPU_BUSY_PCT
      : (resources.cpuPct ?? 0) >= CPU_BUSY_PCT;
  if (cpuBusy) {
    const top = heaviest(resources.groups, "cpu");
    tips.push({
      look: "cpu",
      title: "The processor is working flat out",
      body: top
        ? `${top.name} is using ${formatPct(top.cpuPct)} of it. If it's stuck, stop it; if it's real work, more cores make it faster.`
        : "Everything will feel slower until it calms down.",
      groupId: top?.id ?? null,
      suggestResize: true,
    });
  }
  const volume = resources.volumes[0];
  if (volume && volume.totalGb > 0 && (volume.usedGb / volume.totalGb) * 100 >= DISK_FULL_PCT) {
    const cleanable = (disk?.cleanables ?? [])
      .filter((c) => c.canClean)
      .reduce((sum, c) => sum + (c.bytes ?? 0), 0);
    tips.push({
      look: "disk",
      title: "The disk is almost full",
      body:
        cleanable > 0
          ? `${formatBytes(cleanable)} can be freed safely below (caches and leftovers). New files and apps may not fit until there's room.`
          : "New files and apps may not fit. See what takes the space below.",
      groupId: null,
      suggestResize: true,
    });
  }
  return tips;
}

export interface ChatCandidate {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly cwd: string;
  readonly active: boolean;
  readonly updatedAt: string;
}

/**
 * The chat an agent works for: the one whose folder is the agent's folder —
 * a chat that is running first, then the most recently touched.
 */
export function matchChat(
  cwd: string | null,
  candidates: ReadonlyArray<ChatCandidate>,
): ChatCandidate | null {
  if (!cwd) return null;
  const norm = (p: string) => p.replace(/\/+$/, "");
  const target = norm(cwd);
  const matches = candidates.filter((c) => norm(c.cwd) === target);
  return (
    matches.toSorted(
      (a, b) =>
        Number(b.active) - Number(a.active) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    )[0] ?? null
  );
}

const KIND_WORD: Record<UnoResourceGroup["kind"], string> = {
  app: "app",
  docker: "container",
  service: "service",
  chat: "chat agent",
  terminal: "terminal",
  unowork: "Uno Work",
  program: "program",
  system: "system",
};

/** A note for Uno: what the person is looking at, so the chat starts informed. */
export function askUnoPrompt(
  look: ResourceLook,
  resources: UnoComputerResources | null,
  disk: UnoDiskUsage | null,
): string {
  const lines: string[] = [];
  const topic =
    look === "disk"
      ? "what is taking the disk space"
      : look === "memory"
        ? "what is using the memory"
        : look === "network"
          ? "what is using the network"
          : "what is keeping the processor busy";
  lines.push(`Please look at ${topic} on this computer and help me sort it out.`);
  if (resources) {
    const m = resources.memory;
    lines.push(
      "",
      "What Uno Work shows right now:",
      `- Processor: ${formatPct(resources.cpuPct ?? 0)} of ${resources.cpuCount} cores`,
      `- Memory: ${formatMb(m.usedMb)} used by programs, ${formatMb(m.cacheMb)} cache, ${formatMb(m.availableMb)} available of ${formatMb(m.totalMb)}` +
        (m.swapTotalMb > 0 ? `, swap ${formatMb(m.swapUsedMb)} of ${formatMb(m.swapTotalMb)}` : ""),
    );
    for (const v of resources.volumes) {
      lines.push(
        `- Disk (${v.label}): ${v.usedGb.toFixed(1)} GB used of ${v.totalGb.toFixed(1)} GB`,
      );
    }
    const by = look === "memory" ? "memory" : "cpu";
    const top = resources.groups
      .toSorted((a, b) => (by === "memory" ? b.memMb - a.memMb : b.cpuPct - a.cpuPct))
      .slice(0, 6);
    if (top.length > 0 && look !== "disk") {
      lines.push("", "Heaviest right now:");
      for (const g of top) {
        lines.push(
          `- ${g.name} (${KIND_WORD[g.kind]}${g.detail ? `, ${g.detail}` : ""}): ${formatPct(g.cpuPct)} processor, ${formatMb(g.memMb)} memory, ${g.processCount} process${g.processCount === 1 ? "" : "es"}`,
        );
      }
    }
  }
  if (disk && look === "disk") {
    lines.push("", `Biggest in ${disk.path}:`);
    for (const e of disk.entries.slice(0, 8)) {
      lines.push(`- ${e.name}${e.isDir ? "/" : ""}: ${formatBytes(e.bytes)}`);
    }
    const cleanable = disk.cleanables.filter((c) => (c.bytes ?? 0) > 0);
    if (cleanable.length > 0) {
      lines.push("", "Caches and leftovers:");
      for (const c of cleanable) lines.push(`- ${c.label}: ${formatBytes(c.bytes)}`);
    }
  }
  lines.push(
    "",
    "Explain in plain words what each big item is and whether it's safe to stop or delete. Don't stop, delete or uninstall anything until I say yes.",
  );
  return lines.join("\n");
}

/** SVG path of a series in a `width × height` box, `max` at the top. */
export function seriesPath(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  max: number,
): { line: string; area: string } {
  const points = values.map((v, i) => ({ v: v ?? 0, i }));
  if (points.length < 2 || max <= 0) return { line: "", area: "" };
  const step = width / (points.length - 1);
  const coords = points.map(({ v, i }) => {
    const y = height - (Math.max(0, Math.min(max, v)) / max) * height;
    return `${(i * step).toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${coords.join(" L")}`;
  return { line, area: `${line} L${width},${height} L0,${height} Z` };
}

/** The folders from home down to `path`, for breadcrumbs. */
export function breadcrumbs(home: string, path: string): Array<{ name: string; path: string }> {
  const crumbs = [{ name: "Home folder", path: home }];
  if (path === home || !path.startsWith(`${home}/`)) return crumbs;
  let current = home;
  for (const part of path
    .slice(home.length + 1)
    .split("/")
    .filter(Boolean)) {
    current = `${current}/${part}`;
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}
