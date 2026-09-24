/**
 * "Uno AI spend" on Home: what the account spent on Uno AI today and on each
 * of the last days, and the credits left.
 *
 * The gateway answers `GET /v1/credits` for the machine's key with the
 * account's credits (`llm_balance`) and its running total of everything
 * Uno AI ever charged it (`total_spent`) — one number that only grows. It has
 * no per-day history the machine may read, so the daemon writes the running
 * total down every so often (a sample), and a day's spend is how much the
 * total grew over that day. The person's own day boundaries (time zone) are
 * applied in the interface, from the samples.
 *
 * Only days this computer saw are known: a day before the first sample, or a
 * gap of days while it was asleep, reads as "unknown", never as $0.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AiSpendSample {
  /** ISO time the total was read. */
  readonly at: string;
  readonly totalUsd: number;
}

export interface GatewayCredits {
  readonly balanceUsd: number;
  readonly totalSpentUsd: number;
}

/** `{"llm_balance": n, "total_spent": n, …}` → numbers; null when it isn't that. */
export function parseGatewayCredits(json: unknown): GatewayCredits | null {
  if (typeof json !== "object" || json === null) return null;
  const r = json as Record<string, unknown>;
  const balance = r["llm_balance"];
  const total = r["total_spent"];
  if (typeof balance !== "number" || !Number.isFinite(balance)) return null;
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  return { balanceUsd: balance, totalSpentUsd: Math.max(0, total) };
}

/** Samples closer than this to the one before the last replace the last one. */
export const AI_SPEND_SAMPLE_SPACING_MS = 10 * 60_000;
/** Enough for a week of days plus the baseline before the first of them. */
export const AI_SPEND_KEEP_MS = 9 * 24 * 60 * 60_000;

/**
 * Adds a sample, keeping them about {@link AI_SPEND_SAMPLE_SPACING_MS} apart
 * (a poll every minute moves the newest one forward instead of piling up),
 * and drops what's older than {@link AI_SPEND_KEEP_MS} — except the newest of
 * those, the baseline of the oldest day still kept.
 */
export function recordAiSpendSample(
  samples: ReadonlyArray<AiSpendSample>,
  sample: AiSpendSample,
): AiSpendSample[] {
  const at = Date.parse(sample.at);
  if (!Number.isFinite(at) || !Number.isFinite(sample.totalUsd)) return [...samples];
  const next = samples.filter((s) => Number.isFinite(Date.parse(s.at)) && Date.parse(s.at) < at);
  const beforeLast = next.at(-2);
  if (beforeLast && at - Date.parse(beforeLast.at) < AI_SPEND_SAMPLE_SPACING_MS) {
    next[next.length - 1] = sample;
  } else {
    next.push(sample);
  }
  const cutoff = at - AI_SPEND_KEEP_MS;
  const firstKept = next.findIndex((s) => Date.parse(s.at) >= cutoff);
  const baseline = firstKept === -1 ? next.length - 1 : firstKept - 1;
  if (baseline > 0) next.splice(0, baseline);
  return next;
}

export function normalizeAiSpendSamples(raw: unknown): AiSpendSample[] {
  if (!Array.isArray(raw)) return [];
  const out: AiSpendSample[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r["at"] !== "string" || !Number.isFinite(Date.parse(r["at"]))) continue;
    if (typeof r["totalUsd"] !== "number" || !Number.isFinite(r["totalUsd"])) continue;
    out.push({ at: r["at"], totalUsd: r["totalUsd"] });
  }
  return out.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export type AiSpendStatus = "ok" | "no-key" | "unavailable" | "unknown";

export interface AiSpendSnapshot {
  readonly status: AiSpendStatus;
  readonly creditsUsd: number | null;
  readonly samples: ReadonlyArray<AiSpendSample>;
  readonly checkedAt: string | null;
}

const TIMEOUT_MS = 5_000;
/** How fresh a reading must be to be served without asking the gateway again. */
export const AI_SPEND_MAX_AGE_MS = 60_000;

/**
 * The ledger file (`ai-spend.json` in the daemon's state dir) and the one
 * question to the gateway. Concurrent callers share one call.
 */
export async function openAiSpendLedger(deps: {
  readonly filePath: string;
  readonly gateway: () => Promise<{ readonly baseUrl: string; readonly key: string } | null>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let samples: AiSpendSample[] = [];
  try {
    const parsed = JSON.parse(await readFile(deps.filePath, "utf8")) as { samples?: unknown };
    samples = normalizeAiSpendSamples(parsed.samples);
  } catch {
    // First start or unreadable: start empty.
  }
  let status: AiSpendStatus = "unknown";
  let creditsUsd: number | null = null;
  let checkedAt = 0;
  let running: Promise<void> | null = null;

  const persist = async () => {
    await mkdir(path.dirname(deps.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${deps.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, samples }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, deps.filePath);
  };

  const readOnce = async () => {
    const gateway = await deps.gateway();
    if (!gateway) {
      status = "no-key";
      return;
    }
    const response = await doFetch(`${gateway.baseUrl}/credits`, {
      headers: { authorization: `Bearer ${gateway.key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 405 || response.status === 403) {
      status = "unavailable";
      return;
    }
    if (!response.ok) {
      status = "unknown";
      return;
    }
    const credits = parseGatewayCredits(await response.json());
    if (!credits) {
      status = "unknown";
      return;
    }
    status = "ok";
    creditsUsd = credits.balanceUsd;
    samples = recordAiSpendSample(samples, {
      at: new Date(now()).toISOString(),
      totalUsd: credits.totalSpentUsd,
    });
    await persist().catch(() => undefined);
  };

  const refresh = (maxAgeMs = AI_SPEND_MAX_AGE_MS): Promise<void> => {
    if (running) return running;
    if (checkedAt > 0 && now() - checkedAt < maxAgeMs) return Promise.resolve();
    running = readOnce()
      .catch(() => {
        status = "unknown";
      })
      .finally(() => {
        checkedAt = now();
        running = null;
      });
    return running;
  };

  const snapshot = (): AiSpendSnapshot => ({
    status,
    creditsUsd,
    samples: [...samples],
    checkedAt: checkedAt > 0 ? new Date(checkedAt).toISOString() : null,
  });

  return { refresh, snapshot };
}

export type AiSpendLedger = Awaited<ReturnType<typeof openAiSpendLedger>>;
