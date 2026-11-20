/**
 * Automatic sizing — the computer grows by itself under load (cores and
 * memory, up to 4× its own size, free) and shrinks back when it is quiet.
 *
 *   GET /api/v1/boxes/{id}         → `autosize: {max_vcpu, max_ram_mb}` when it is on for the account
 *   GET /api/v1/boxes/{id}/sizing  → mode, cpu / memory_mb / disk_gb {current, base, max}, history
 *
 * `/sizing` asks the computer's node, so it is only called when the box says
 * `autosize`. A computer that booted before it was turned on answers
 * `mode: none` — nothing shows, as for everyone else.
 *
 * Kept free of Effect so tests drive it with recorded payloads.
 */
import type {
  UnoComputerSizing,
  UnoComputerSizingEvent,
  UnoComputerSizingRange,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `autosize` of `GET /boxes/{id}`: is it worth asking `/sizing`. */
export function hasAutosize(boxRecord: unknown): boolean {
  const a = asRecord(asRecord(boxRecord)?.["autosize"]);
  return a !== null && num(a["max_vcpu"]) > 0;
}

function range(raw: unknown): UnoComputerSizingRange | null {
  const r = asRecord(raw);
  if (!r) return null;
  const current = num(r["current"]);
  const base = num(r["base"], current);
  const max = Math.max(num(r["max"], base), base);
  return { current, base, max };
}

const HISTORY_MAX = 20;

/** `GET /boxes/{id}/sizing`; null — nothing to show (off for this computer, a bad answer). */
export function parseComputerSizing(raw: unknown): UnoComputerSizing | null {
  const r = asRecord(raw);
  if (!r) return null;
  const mode = r["mode"];
  if (mode !== "auto" && mode !== "off") return null;
  const cpu = range(r["cpu"]);
  const memoryMb = range(r["memory_mb"]);
  const diskGb = range(r["disk_gb"]) ?? { current: 0, base: 0, max: 0 };
  if (!cpu || !memoryMb) return null;
  const history: UnoComputerSizingEvent[] = [];
  for (const item of Array.isArray(r["history"]) ? r["history"] : []) {
    const e = asRecord(item);
    if (!e) continue;
    const reason = typeof e["reason"] === "string" ? e["reason"] : "";
    if (reason === "boot") continue;
    const res = e["resource"];
    const resource = res === "cpu" ? "cpu" : res === "memory_mb" ? "memory" : null;
    const at = typeof e["at"] === "string" ? e["at"] : null;
    if (!resource || !at) continue;
    history.push({
      seq: num(e["seq"]),
      at,
      resource,
      from: num(e["from"]),
      to: num(e["to"]),
      reason,
      applied: e["applied"] === true,
    });
  }
  return { mode, cpu, memoryMb, diskGb, history: history.slice(-HISTORY_MAX) };
}
