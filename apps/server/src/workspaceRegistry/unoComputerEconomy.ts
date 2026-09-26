/**
 * Economy mode of an Uno computer ("runs only when needed").
 *
 *   GET   /api/v1/boxes/{id}          → `economy` (absent: not offered yet)
 *   GET   /api/v1/boxes/{id}/economy  → the same object
 *   PATCH /api/v1/boxes/{id}/economy  {"enabled": bool, "idle_timeout_s": n}
 *
 * The console decides when the computer sleeps (fishcode box/economy.go); the
 * daemon only shows the state, lets the person switch it and reports what is
 * going on inside (`economy/EconomyPresence.ts`).
 *
 * Kept free of Effect so tests drive it with recorded payloads.
 */
import type { UnoComputerEconomy } from "@t3tools/contracts";

import {
  NOT_LINKED_MESSAGE,
  NO_COMPUTER_MESSAGE,
  UnoComputerActionError,
  controlPlaneErrorBody,
  humanizeControlPlaneError,
} from "./unoComputer.ts";
import type { UnoComputerClientContext } from "./unoComputer.ts";
import { fetchControlPlaneJson } from "./unoCloudParse.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The console's `economy` object; null when absent or malformed. */
export function parseComputerEconomy(raw: unknown): UnoComputerEconomy | null {
  const record = asRecord(raw);
  if (!record || typeof record["enabled"] !== "boolean") return null;
  const busy = Array.isArray(record["busy"])
    ? record["busy"].filter((item): item is string => typeof item === "string")
    : [];
  return {
    enabled: record["enabled"],
    locked: record["locked"] === true,
    source: str(record["source"]) ?? "plan",
    idleTimeoutS: num(record["idle_timeout_s"], 600),
    defaultIdleTimeoutS: num(record["default_idle_timeout_s"], 600),
    state: str(record["state"]) ?? (record["enabled"] ? "awake" : "off"),
    sleepAfter: str(record["sleep_after"]),
    busy,
    lastSleepAt: str(record["last_sleep_at"]),
    lastWakeAt: str(record["last_wake_at"]),
    lastWakeSource: str(record["last_wake_source"]),
  };
}

/** Plain words for the idle timer: "10 minutes", "1 hour". */
export function economyIdleLabel(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  const m = Math.max(1, Math.round(seconds / 60));
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/**
 * PATCH the economy setting. Refusals come back as readable errors: the free
 * trial computer cannot leave economy mode; an older console has no route.
 */
export async function setComputerEconomy(
  ctx: UnoComputerClientContext & {
    readonly boxId: number | null;
    readonly enabled?: boolean | undefined;
    readonly idleTimeoutS?: number | undefined;
  },
): Promise<UnoComputerEconomy> {
  const apiKey = ctx.apiKey.trim();
  if (apiKey.length === 0) throw new UnoComputerActionError(NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) throw new UnoComputerActionError(NO_COMPUTER_MESSAGE);
  const body: Record<string, unknown> = {};
  if (ctx.enabled !== undefined) body["enabled"] = ctx.enabled;
  if (ctx.idleTimeoutS !== undefined) body["idle_timeout_s"] = ctx.idleTimeoutS;
  const fetchJson = ctx.fetchJson ?? fetchControlPlaneJson;
  let raw: unknown;
  try {
    raw = await fetchJson(apiKey, `/api/v1/boxes/${ctx.boxId}/economy`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  } catch (cause) {
    const err = controlPlaneErrorBody(cause);
    if (err?.code === "ECONOMY_MODE_LOCKED") {
      throw new UnoComputerActionError(
        "The free computer always runs in economy mode. Pick a plan to keep it on all the time.",
      );
    }
    if (err?.code === "ECONOMY_MODE_UNAVAILABLE" || err?.code === "NOT_FOUND") {
      throw new UnoComputerActionError("Economy mode isn't available for this computer yet.");
    }
    throw new UnoComputerActionError(humanizeControlPlaneError(cause));
  }
  const parsed = parseComputerEconomy(raw);
  if (!parsed) throw new UnoComputerActionError("The console answered without economy settings.");
  return parsed;
}
