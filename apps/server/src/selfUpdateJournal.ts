/**
 * After Uno Work updated itself (selfUpdate.ts) the computer tells the console,
 * once per run, so the owner sees it in Security → "Who got in":
 * "You updated Uno Work to 0.0.113".
 *
 * The console builds the journal text itself from the two versions and the
 * outcome (fishcode `POST /api/v1/boxes/{id}/security/work-update`); the
 * computer cannot put free text there.
 *
 * "By the owner" is what the daemon knows: the request came through the
 * owner-only route (it leaves a note next to its state) shortly before the
 * updater started.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { UpdaterStatus } from "./selfUpdate.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const INTENT_FILE = "self-update-intent.json";
const REPORTED_FILE = "self-update-reported.json";
/** The updater starts within seconds of the request; allow a slow systemd. */
const INTENT_WINDOW_MS = 5 * 60_000;
const RETRY_AFTER_MS = 5 * 60_000;
const TIMEOUT_MS = 15_000;

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** The owner pressed Update (called by the owner-only route). */
export async function noteSelfUpdateIntent(stateDir: string, now = Date.now()): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeJson(join(stateDir, INTENT_FILE), { requestedAt: new Date(now).toISOString() });
}

export function startedByOwner(run: UpdaterStatus, intentAt: string | null): boolean {
  const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const asked = intentAt ? Date.parse(intentAt) : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(asked)) return false;
  // The updater writes whole seconds; the request can be up to a second "later".
  return asked <= started + 2_000 && started - asked <= INTENT_WINDOW_MS;
}

export interface SelfUpdateReport {
  readonly from_version: string;
  readonly to_version: string;
  readonly outcome: "updated" | "rolled_back";
  readonly by_owner: boolean;
}

/** What to tell the console about a finished run, or null when there is nothing to tell. */
export function selfUpdateReportFor(
  run: UpdaterStatus | null,
  intentAt: string | null,
): SelfUpdateReport | null {
  if (!run?.finishedAt || !run.fromVersion || !run.toVersion) return null;
  const outcome =
    run.state === "done"
      ? "updated"
      : run.state === "failed" && run.rolledBack
        ? "rolled_back"
        : null;
  if (!outcome || run.fromVersion === run.toVersion) return null;
  return {
    from_version: run.fromVersion,
    to_version: run.toVersion,
    outcome,
    by_owner: startedByOwner(run, intentAt),
  };
}

let lastAttemptAt = 0;
let inFlight: Promise<void> | null = null;

/**
 * Tell the console about the last finished run, unless it already knows.
 * Never rejects; a console that is unreachable gets another try later.
 */
export function reportSelfUpdate(input: {
  readonly stateDir: string;
  readonly lastRun: () => Promise<UpdaterStatus | null>;
  readonly identity: { readonly boxToken: string; readonly boxId: number } | null;
  readonly consoleBaseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}): Promise<void> {
  if (inFlight) return inFlight;
  const now = input.now ?? Date.now;
  inFlight = (async () => {
    if (!input.identity) return;
    const run = await input.lastRun();
    if (!run?.finishedAt) return;
    const reportedPath = join(input.stateDir, REPORTED_FILE);
    const reported = await readJson(reportedPath);
    if (reported?.["finishedAt"] === run.finishedAt) return;
    const intent = await readJson(join(input.stateDir, INTENT_FILE));
    const intentAt = typeof intent?.["requestedAt"] === "string" ? intent["requestedAt"] : null;
    const report = selfUpdateReportFor(run, intentAt);
    if (!report) return;
    if (now() - lastAttemptAt < RETRY_AFTER_MS) return;
    lastAttemptAt = now();
    const fetchImpl = input.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(
      `${input.consoleBaseUrl}/api/v1/boxes/${input.identity.boxId}/security/work-update`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.identity.boxToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    // 2xx — recorded. 4xx — this console will never take it (older console,
    // or it refused the body): don't ask again. 5xx / network — try later.
    if (response.status < 500) {
      await mkdir(input.stateDir, { recursive: true });
      await writeJson(reportedPath, { finishedAt: run.finishedAt, status: response.status });
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Tests only. */
export function resetSelfUpdateReportState(): void {
  lastAttemptAt = 0;
  inFlight = null;
}
