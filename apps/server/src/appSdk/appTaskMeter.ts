/**
 * What an app's tasks spend (docs/app-sdk.md, "Tasks and the app's limit").
 *
 * A task runs in a harness that calls the Uno AI gateway with the machine's
 * key; the daemon marks those calls with the app's id (`appTaskLabel.ts`)
 * and the gateway sums the billed cost per label for that key
 * (`GET /v1/usage/apps`). The gateway knows exactly what it charged, so the
 * daemon doesn't price anything here — it only turns the gateway's running
 * totals into the app's own ledger:
 *
 * - `taskSpentUsd` grows by what the gateway total grew since last time;
 * - "Reset" zeroes the ledger, not the gateway (the total keeps growing, and
 *   only its growth counts from then on);
 * - a new machine key starts a new total at 0 — the key tag tells them apart,
 *   so a re-minted key neither loses nor double counts.
 *
 * Tasks on Claude Code / Codex / Cursor / plain OpenCode don't touch the Uno
 * gateway (the person's own subscription or keys) and so add nothing.
 */
import { createHash } from "node:crypto";

import type { StoredApp } from "./appAiStore.ts";

export interface GatewayAppUsage {
  readonly app: string;
  readonly costUsd: number;
}

/** `{"object":"list","data":[{"app","cost_usd","requests"}]}` → rows; null if it isn't that. */
export function parseGatewayAppUsage(json: unknown): GatewayAppUsage[] | null {
  if (typeof json !== "object" || json === null) return null;
  const data = (json as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) return null;
  const rows: GatewayAppUsage[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const cost = r["cost_usd"];
    if (typeof r["app"] !== "string" || typeof cost !== "number" || !Number.isFinite(cost)) {
      continue;
    }
    rows.push({ app: r["app"], costUsd: Math.max(0, cost) });
  }
  return rows;
}

/** A short, non-reversible tag of the machine key (never the key itself). */
export function gatewayKeyTag(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Folds the gateway's totals into one app's ledger (mutates `app`). Returns
 * true when anything changed.
 */
export function applyGatewayTotal(app: StoredApp, total: number, keyTag: string): boolean {
  const before = [app.taskSpentUsd, app.taskGatewaySeenUsd, app.taskGatewayKeyTag] as const;
  if (app.taskGatewayKeyTag !== keyTag) {
    // Another key: its total starts from zero, everything in it is new.
    app.taskGatewayKeyTag = keyTag;
    app.taskGatewaySeenUsd = 0;
  }
  const grown = total - app.taskGatewaySeenUsd;
  // The gateway's total never shrinks for the same key; if it ever does
  // (rows removed by hand), take the new total as the baseline, add nothing.
  if (grown > 0) app.taskSpentUsd = round6(app.taskSpentUsd + grown);
  app.taskGatewaySeenUsd = round6(total);
  return (
    before[0] !== app.taskSpentUsd ||
    before[1] !== app.taskGatewaySeenUsd ||
    before[2] !== app.taskGatewayKeyTag
  );
}

export type TaskMeterStatus =
  /** Totals come from the gateway. */
  | "metered"
  /** The gateway doesn't serve per-app totals yet (older backend) — tasks aren't counted. */
  | "unavailable"
  /** No AI key on this machine: no Uno spending, nothing to count. */
  | "no-key"
  /** Not asked yet, or the last try failed (network) — the ledger keeps its last numbers. */
  | "unknown";

export interface TaskMeterDeps {
  readonly gateway: () => Promise<{ readonly baseUrl: string; readonly key: string } | null>;
  /** Apps whose totals to fold in (the ones that ever started a task). */
  readonly apps: () => ReadonlyArray<StoredApp>;
  /** Persists the ledger after `applyGatewayTotal` changed apps. */
  readonly persist: () => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export const TASK_METER_MAX_AGE_MS = 20_000;
const TASK_METER_TIMEOUT_MS = 5_000;

export function makeTaskMeter(deps: TaskMeterDeps) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let status: TaskMeterStatus = "unknown";
  let checkedAt = 0;
  let running: Promise<void> | null = null;

  const refreshOnce = async () => {
    const apps = deps.apps();
    if (apps.length === 0) return;
    const gateway = await deps.gateway();
    if (!gateway) {
      status = "no-key";
      return;
    }
    const response = await doFetch(`${gateway.baseUrl}/usage/apps`, {
      headers: { authorization: `Bearer ${gateway.key}` },
      signal: AbortSignal.timeout(TASK_METER_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 405) {
      status = "unavailable";
      return;
    }
    if (!response.ok) {
      status = "unknown";
      return;
    }
    const rows = parseGatewayAppUsage(await response.json());
    if (rows === null) {
      status = "unknown";
      return;
    }
    const totals = new Map(rows.map((row) => [row.app, row.costUsd]));
    const tag = gatewayKeyTag(gateway.key);
    let changed = false;
    for (const app of apps) {
      if (applyGatewayTotal(app, totals.get(app.id) ?? 0, tag)) changed = true;
    }
    status = "metered";
    if (changed) await deps.persist();
  };

  /** Asks the gateway unless it was asked within `maxAgeMs`; concurrent callers share one call. */
  const refresh = (maxAgeMs = TASK_METER_MAX_AGE_MS): Promise<void> => {
    if (running) return running;
    if (now() - checkedAt < maxAgeMs) return Promise.resolve();
    running = refreshOnce()
      .catch(() => {
        status = "unknown";
      })
      .finally(() => {
        checkedAt = now();
        running = null;
      });
    return running;
  };

  return { refresh, status: () => status };
}

export type TaskMeter = ReturnType<typeof makeTaskMeter>;
