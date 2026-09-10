/**
 * In-memory job table shared by the install and sign-in flows.
 *
 * Rules:
 *   - one active job per (kind, driver): starting a second one is a conflict;
 *   - `queued → running → succeeded | failed` is the only allowed path;
 *   - logs are capped (see `appendCappedLog`) and secrets scrubbed on the way in;
 *   - settled jobs are pruned after `SETTLED_JOB_TTL_MS` so a client that
 *     polls late still sees the final state, but the table cannot grow forever.
 *
 * @module provider/setup/harnessJobs
 */
import { type ProviderSetupJobId, type ProviderSetupJobState } from "@t3tools/contracts";

import { appendCappedLog, scrubSecret } from "./harnessSetupParsers.ts";

export type SetupJobKind = "install" | "auth";

/** How long a finished job stays readable. */
export const SETTLED_JOB_TTL_MS = 30 * 60_000;

export interface SetupJobRecord<Extra extends object> {
  readonly jobId: ProviderSetupJobId;
  readonly kind: SetupJobKind;
  readonly driver: string;
  readonly state: ProviderSetupJobState;
  readonly log: string;
  readonly error: string | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly extra: Extra;
}

export type SetupJobStartResult<Extra extends object> =
  | { readonly ok: true; readonly job: SetupJobRecord<Extra> }
  | { readonly ok: false; readonly conflict: SetupJobRecord<Extra> };

export interface SetupJobStoreOptions {
  readonly now?: () => number;
  readonly makeJobId?: () => string;
  readonly logCapBytes?: number;
  readonly settledTtlMs?: number;
}

const isActiveState = (state: ProviderSetupJobState): boolean =>
  state === "queued" || state === "running";

export class SetupJobStore<Extra extends object = Record<never, never>> {
  private readonly jobs = new Map<string, SetupJobRecord<Extra>>();
  /** Secret to scrub from a job's log, when the job carries one. */
  private readonly secrets = new Map<string, string>();
  private readonly now: () => number;
  private readonly makeJobId: () => string;
  private readonly logCapBytes: number | undefined;
  private readonly settledTtlMs: number;

  constructor(options: SetupJobStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.makeJobId = options.makeJobId ?? (() => crypto.randomUUID());
    this.logCapBytes = options.logCapBytes;
    this.settledTtlMs = options.settledTtlMs ?? SETTLED_JOB_TTL_MS;
  }

  /** Active job for (kind, driver), if any. */
  findActive(kind: SetupJobKind, driver: string): SetupJobRecord<Extra> | undefined {
    for (const job of this.jobs.values()) {
      if (job.kind === kind && job.driver === driver && isActiveState(job.state)) {
        return job;
      }
    }
    return undefined;
  }

  start(input: {
    readonly kind: SetupJobKind;
    readonly driver: string;
    readonly extra: Extra;
    /** Scrubbed from every log chunk appended to this job. */
    readonly secret?: string;
  }): SetupJobStartResult<Extra> {
    this.prune();
    const conflict = this.findActive(input.kind, input.driver);
    if (conflict) return { ok: false, conflict };

    const timestamp = this.now();
    const job: SetupJobRecord<Extra> = {
      jobId: this.makeJobId() as ProviderSetupJobId,
      kind: input.kind,
      driver: input.driver,
      state: "queued",
      log: "",
      error: undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
      extra: input.extra,
    };
    this.jobs.set(job.jobId, job);
    if (input.secret) this.secrets.set(job.jobId, input.secret);
    return { ok: true, job };
  }

  get(jobId: string): SetupJobRecord<Extra> | undefined {
    return this.jobs.get(jobId);
  }

  markRunning(jobId: string): SetupJobRecord<Extra> | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "queued") return job;
    return this.replace({ ...job, state: "running" });
  }

  appendLog(jobId: string, chunk: string): SetupJobRecord<Extra> | undefined {
    const job = this.jobs.get(jobId);
    if (!job || !isActiveState(job.state)) return job;
    const scrubbed = scrubSecret(chunk, this.secrets.get(jobId));
    return this.replace({ ...job, log: appendCappedLog(job.log, scrubbed, this.logCapBytes) });
  }

  updateExtra(jobId: string, patch: Partial<Extra>): SetupJobRecord<Extra> | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    return this.replace({ ...job, extra: { ...job.extra, ...patch } });
  }

  /** Terminal transition. No-op when the job already settled. */
  finish(
    jobId: string,
    outcome: { readonly state: "succeeded" } | { readonly state: "failed"; readonly error: string },
  ): SetupJobRecord<Extra> | undefined {
    const job = this.jobs.get(jobId);
    if (!job || !isActiveState(job.state)) return job;
    const error =
      outcome.state === "failed" ? scrubSecret(outcome.error, this.secrets.get(jobId)) : undefined;
    this.secrets.delete(jobId);
    return this.replace({ ...job, state: outcome.state, error });
  }

  /** Drop settled jobs older than the TTL. Returns how many were removed. */
  prune(): number {
    const cutoff = this.now() - this.settledTtlMs;
    let removed = 0;
    for (const [jobId, job] of this.jobs) {
      if (!isActiveState(job.state) && job.updatedAt < cutoff) {
        this.jobs.delete(jobId);
        this.secrets.delete(jobId);
        removed += 1;
      }
    }
    return removed;
  }

  activeJobs(): ReadonlyArray<SetupJobRecord<Extra>> {
    return [...this.jobs.values()].filter((job) => isActiveState(job.state));
  }

  private replace(job: SetupJobRecord<Extra>): SetupJobRecord<Extra> {
    const next = { ...job, updatedAt: this.now() };
    this.jobs.set(job.jobId, next);
    return next;
  }
}
