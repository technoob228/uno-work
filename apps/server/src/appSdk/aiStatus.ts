/**
 * Uno AI hours: how the account's AI is doing right now — hours left, AI
 * power, how many requests are running and whether they are slowed down.
 *
 * `GET {gateway}/ai/status` with the machine's key (spec: fishcode
 * `back/knowledge/ai-hours.md`). Cheap, but still only asked while a chat is
 * working (the interface polls every 15 s then) and at most once per
 * {@link AI_STATUS_MAX_AGE_MS}; concurrent callers share one call. A gateway
 * without AI hours answers 404 — then the status is "unavailable" and the
 * gateway is not asked again for {@link AI_STATUS_UNAVAILABLE_BACKOFF_MS}.
 */
import type { UnoAiStatus } from "@t3tools/contracts";

const TIMEOUT_MS = 5_000;
/** The interface polls every 15 s while a chat works; one gateway call per window. */
export const AI_STATUS_MAX_AGE_MS = 12_000;
/** A gateway without `/v1/ai/status` is asked again only this much later. */
export const AI_STATUS_UNAVAILABLE_BACKOFF_MS = 10 * 60_000;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

type StatusFields = Omit<UnoAiStatus, "status" | "checkedAt">;

export const EMPTY_AI_STATUS_FIELDS: StatusFields = {
  hoursLeftMinutes: null,
  unlimited: false,
  fullSpeedHoursLeft: null,
  usedTodayMinutes: null,
  power: null,
  inFlight: null,
  throttled: false,
  speedPct: null,
  renewsAt: null,
  plan: null,
};

/** The gateway's JSON → fields; null when it isn't a status at all. */
export function parseGatewayAiStatus(json: unknown): StatusFields | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const r = json as Record<string, unknown>;
  // AI hours off for this account (flag): the gateway answers with zeros.
  if (r["enabled"] === false) return null;
  const known = ["hours_left_minutes", "throttled", "speed_pct", "power", "unlimited"];
  if (!known.some((key) => key in r)) return null;
  const speedPct = num(r["speed_pct"]);
  return {
    hoursLeftMinutes: num(r["hours_left_minutes"]),
    unlimited: r["unlimited"] === true,
    fullSpeedHoursLeft: num(r["full_speed_hours_left"]),
    usedTodayMinutes: num(r["used_today_minutes"]),
    power: num(r["power"]),
    inFlight: num(r["in_flight"]),
    // Slowed down: the gateway says so, or reports less than full speed.
    throttled: r["throttled"] === true || (speedPct !== null && speedPct < 100),
    speedPct,
    renewsAt: str(r["renews_at"]),
    plan: str(r["plan"]),
  };
}

export function openAiStatusReader(deps: {
  readonly gateway: () => Promise<{ readonly baseUrl: string; readonly key: string } | null>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let current: UnoAiStatus = { status: "unknown", ...EMPTY_AI_STATUS_FIELDS, checkedAt: null };
  let checkedAt = 0;
  let running: Promise<void> | null = null;

  const set = (status: UnoAiStatus["status"], fields: StatusFields = EMPTY_AI_STATUS_FIELDS) => {
    current = { status, ...fields, checkedAt: new Date(now()).toISOString() };
  };

  const readOnce = async () => {
    const gateway = await deps.gateway();
    if (!gateway) return set("no-key");
    const response = await doFetch(`${gateway.baseUrl}/ai/status`, {
      headers: { authorization: `Bearer ${gateway.key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 405 || response.status === 403) {
      return set("unavailable");
    }
    if (!response.ok) return set("unknown");
    const fields = parseGatewayAiStatus(await response.json().catch(() => null));
    return fields ? set("ok", fields) : set("unavailable");
  };

  const read = async (): Promise<UnoAiStatus> => {
    const maxAge =
      current.status === "unavailable" ? AI_STATUS_UNAVAILABLE_BACKOFF_MS : AI_STATUS_MAX_AGE_MS;
    if (running) {
      await running;
      return current;
    }
    if (checkedAt > 0 && now() - checkedAt < maxAge) return current;
    running = readOnce()
      .catch(() => set("unknown"))
      .finally(() => {
        checkedAt = now();
        running = null;
      });
    await running;
    return current;
  };

  return { read };
}

export type AiStatusReader = ReturnType<typeof openAiStatusReader>;
