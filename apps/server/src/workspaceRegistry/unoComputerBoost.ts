/**
 * "Boost ×2 for 1 hour" — this computer restarts into twice its size for an
 * hour, then restarts once more back to normal.
 *
 *   GET    /api/v1/boxes/{id}        → `boost` (only when offered to the account)
 *   POST   /api/v1/boxes/{id}/boost  {"hours":1} → 202 {"boost": {…state "starting"}}
 *   DELETE /api/v1/boxes/{id}/boost  → 202 {"boost": {…state "ending"}}
 *
 * The control plane is the only judge (daily hours, capacity, the computer
 * being on); a refusal comes back as `refused` with plain words, never as
 * an error. "Already boosted" / "not boosted any more" are not refusals: the
 * person wanted that state and has it, so the fresh state is returned.
 *
 * The daemon asking for the boost runs on the computer that restarts, so the
 * answer may never reach the browser; the UI re-reads the state after the
 * reconnect. Nothing here depends on the answer arriving.
 *
 * Kept free of Effect so tests drive it with recorded payloads.
 */
import type {
  UnoComputerBoost,
  UnoComputerBoostResult,
  UnoComputerBoostState,
} from "@t3tools/contracts";

import {
  NOT_LINKED_MESSAGE,
  NO_COMPUTER_MESSAGE,
  humanizeControlPlaneError,
} from "./unoComputer.ts";
import type { UnoComputerClientContext } from "./unoComputer.ts";
import {
  asNullableString,
  controlPlaneErrorStatus,
  fetchControlPlaneJson,
} from "./unoCloudParse.ts";

export const BOOST_HOURS = 1;

const STATES: ReadonlyArray<UnoComputerBoostState> = ["off", "starting", "active", "ending"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The `boost` object of `GET /boxes/{id}` (or of a POST/DELETE answer).
 * `null` — the account doesn't have boost: nothing about it shows.
 */
export function parseComputerBoost(raw: unknown): UnoComputerBoost | null {
  const record = asRecord(raw);
  if (!record) return null;
  const rawState = typeof record["state"] === "string" ? record["state"] : "off";
  const state = (STATES as ReadonlyArray<string>).includes(rawState)
    ? (rawState as UnoComputerBoostState)
    : "off";
  const baseRamMb = num(record["base_ram_mb"]);
  const baseVcpu = num(record["base_vcpu"]);
  const reason = asNullableString(record["reason"])?.trim() ?? "";
  return {
    available: record["available"] === true,
    state,
    ramMb: num(record["ram_mb"], baseRamMb * 2),
    vcpu: num(record["vcpu"], baseVcpu * 2),
    baseRamMb,
    baseVcpu,
    hours: num(record["hours"], BOOST_HOURS),
    startedAt: asNullableString(record["started_at"]),
    endsAt: asNullableString(record["ends_at"]),
    hoursLeftToday: num(record["hours_left_today"]),
    hoursPerDay: num(record["hours_per_day"]),
    reason: reason.length > 0 ? reason : null,
  };
}

/** `{"boost": {...}}` from POST/DELETE, or a bare boost object. */
function boostFromAnswer(raw: unknown): UnoComputerBoost | null {
  const record = asRecord(raw);
  return parseComputerBoost(record?.["boost"] ?? record);
}

/** The code in `409: {"error":"BOOST_ACTIVE"}`. */
export function boostErrorCode(cause: unknown): string | null {
  const text = cause instanceof Error ? cause.message : String(cause);
  return (
    /"error"\s*:\s*"([A-Z0-9_]+)"/.exec(text)?.[1] ??
    /\b(BOOST_[A-Z_]+|BOX_NOT_RUNNING)\b/.exec(text)?.[1] ??
    null
  );
}

const REFUSAL_WORDS: Record<string, string> = {
  BOOST_NOT_AVAILABLE: "Boost isn't available for this computer right now.",
  BOOST_INVALID_HOURS: "A boost lasts one hour.",
  BOX_NOT_RUNNING: "Your computer needs to be on to boost. Wake it up and try again.",
  BOOST_NO_CAPACITY: "Uno can't boost right now — try again in a few minutes.",
  BOOST_DAILY_LIMIT: "You've used all of today's boost hours. They come back tomorrow.",
};

/** Plain words for a refusal; `null` — not a boost refusal. */
export function boostRefusalMessage(cause: unknown): string | null {
  const code = boostErrorCode(cause);
  return code ? (REFUSAL_WORDS[code] ?? null) : null;
}

export class BoostActionError extends Error {}

function bind(ctx: UnoComputerClientContext) {
  const apiKey = ctx.apiKey.trim();
  if (apiKey.length === 0) return null;
  const fetchJson = ctx.fetchJson ?? fetchControlPlaneJson;
  return (path: string, init?: RequestInit) => fetchJson(apiKey, path, init);
}

async function freshBoost(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
  boxId: number,
): Promise<UnoComputerBoost | null> {
  try {
    return parseComputerBoost(asRecord(await request(`/api/v1/boxes/${boxId}`))?.["boost"]);
  } catch {
    return null;
  }
}

function actionError(cause: unknown, verb: string): BoostActionError {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (text.includes("WORK_MACHINE_TOKEN_RESTRICTED")) {
    return new BoostActionError(
      `This computer's key is older than the boost button. Open this computer once from the Uno console to refresh it, then ${verb} again.`,
    );
  }
  return new BoostActionError(humanizeControlPlaneError(cause));
}

export async function startBoost(
  ctx: UnoComputerClientContext & { readonly boxId: number | null; readonly hours?: number },
): Promise<UnoComputerBoostResult> {
  const request = bind(ctx);
  if (!request) throw new BoostActionError(NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) throw new BoostActionError(NO_COMPUTER_MESSAGE);
  try {
    const answer = await request(`/api/v1/boxes/${ctx.boxId}/boost`, {
      method: "POST",
      body: JSON.stringify({ hours: ctx.hours ?? BOOST_HOURS }),
    });
    return { outcome: "started", message: null, boost: boostFromAnswer(answer) };
  } catch (cause) {
    if (boostErrorCode(cause) === "BOOST_ACTIVE") {
      return { outcome: "started", message: null, boost: await freshBoost(request, ctx.boxId) };
    }
    const message = boostRefusalMessage(cause);
    if (message) {
      const boost = await freshBoost(request, ctx.boxId);
      // The control plane's own words are more precise ("resets at 00:00 UTC").
      const reason =
        boostErrorCode(cause) === "BOOST_NOT_AVAILABLE" && boost?.reason ? boost.reason : message;
      return { outcome: "refused", message: reason, boost };
    }
    if (controlPlaneErrorStatus(cause) === 429) {
      return {
        outcome: "refused",
        message: REFUSAL_WORDS["BOOST_DAILY_LIMIT"]!,
        boost: await freshBoost(request, ctx.boxId),
      };
    }
    throw actionError(cause, "boost");
  }
}

export async function endBoost(
  ctx: UnoComputerClientContext & { readonly boxId: number | null },
): Promise<UnoComputerBoostResult> {
  const request = bind(ctx);
  if (!request) throw new BoostActionError(NOT_LINKED_MESSAGE);
  if (ctx.boxId === null) throw new BoostActionError(NO_COMPUTER_MESSAGE);
  try {
    const answer = await request(`/api/v1/boxes/${ctx.boxId}/boost`, { method: "DELETE" });
    return { outcome: "ended", message: null, boost: boostFromAnswer(answer) };
  } catch (cause) {
    if (boostErrorCode(cause) === "BOOST_NOT_ACTIVE") {
      return { outcome: "ended", message: null, boost: await freshBoost(request, ctx.boxId) };
    }
    throw actionError(cause, "end the boost");
  }
}
