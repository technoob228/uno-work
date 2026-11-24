/**
 * "Update everything": Uno Work and the agents on the person's computers, then
 * this app. The pure half: what each computer needs, which ones are ticked when
 * the list opens, in what order and with what time limits it runs.
 *
 * The notice's Update button runs the same plan for one computer (the one the
 * notice is about) and this app; the full list is the secondary path.
 *
 * The order inside a computer is agents first, then Uno Work: Work restarts the
 * daemon that runs the agents' update. The computer this page comes from goes
 * last, because its restart takes the page's connection down for a minute. The
 * app goes after everything, it restarts this window.
 *
 * Nothing here changes a machine's image: the updater and the install jobs are
 * what each computer already has.
 */
import type { AgentUpdateStatus } from "@t3tools/shared/agentVersions";

import { workingAgentsOf, type SelfUpdateStatus } from "../selfUpdate/selfUpdate";

export interface UpdateTarget {
  readonly key: string;
  readonly label: string;
  /** Null: a computer on the account nothing has connected to yet. */
  readonly environmentId: string | null;
  readonly boxId: number | null;
  /** The computer this page comes from. */
  readonly isPrimary: boolean;
  /** `asleep` also covers a box that's up but not connected from here yet. */
  readonly reach: "online" | "asleep" | "offline";
  /** Null: this computer has no self-update (a Mac updates with the app) or wasn't asked yet. */
  readonly selfUpdate: SelfUpdateStatus | null | undefined;
  readonly agents: ReadonlyArray<AgentUpdateStatus> | null | undefined;
  readonly runningChats: number;
}

export interface PlanRow {
  readonly key: string;
  readonly label: string;
  readonly environmentId: string | null;
  readonly boxId: number | null;
  readonly isPrimary: boolean;
  /** The Work version to go to; null: nothing to do for Work. */
  readonly work: string | null;
  readonly agents: ReadonlyArray<AgentUpdateStatus>;
  /** Asleep: it wakes when the update starts, and what it needs shows then. */
  readonly wakes: boolean;
  /** Why this computer stays as it is; null when it takes part. */
  readonly skipped: string | null;
  readonly runningChats: number;
  /** Agents the computer itself counts; 0 on one too old to wait for them. */
  readonly workingAgents: number;
}

export function buildUpdatePlan(targets: ReadonlyArray<UpdateTarget>): ReadonlyArray<PlanRow> {
  const rows = targets.map((target): PlanRow => {
    const base = {
      key: target.key,
      label: target.label,
      environmentId: target.environmentId,
      boxId: target.boxId,
      isPrimary: target.isPrimary,
      runningChats: target.runningChats,
      workingAgents: workingAgentsOf(target.selfUpdate),
    };
    if (target.reach === "offline") {
      return { ...base, work: null, agents: [], wakes: false, skipped: "Offline" };
    }
    if (target.reach === "asleep") {
      return target.boxId !== null
        ? { ...base, work: null, agents: [], wakes: true, skipped: null }
        : { ...base, work: null, agents: [], wakes: false, skipped: "Asleep" };
    }
    const self = target.selfUpdate;
    const work = self?.available && self.canUpdate ? self.latestVersion : null;
    const agents = target.agents?.filter((agent) => agent.behind) ?? [];
    const ownerOnly = self?.available === true && !self.canUpdate && agents.length === 0;
    return {
      ...base,
      work,
      agents,
      wakes: false,
      skipped: ownerOnly ? "Only its owner can update it" : null,
    };
  });
  return rows.toSorted((a, b) => Number(a.isPrimary) - Number(b.isPrimary));
}

export function planNeedsWork(row: PlanRow): boolean {
  return row.skipped === null && (row.work !== null || row.agents.length > 0 || row.wakes);
}

export function planCount(rows: ReadonlyArray<PlanRow>): number {
  return rows.filter(planNeedsWork).length;
}

/** Chats a restart of Work would cut off. */
export function planStoppedChats(rows: ReadonlyArray<PlanRow>): number {
  return rows.reduce(
    (sum, row) => sum + (row.work !== null ? Math.max(row.runningChats, row.workingAgents) : 0),
    0,
  );
}

/**
 * Agents that "Update when they finish" can wait for: only a computer that
 * counts its agents itself can hold the update back. An older one updates at
 * once whatever it is asked.
 */
export function planWaitableAgents(rows: ReadonlyArray<PlanRow>): number {
  return rows.reduce((sum, row) => sum + (row.work !== null ? row.workingAgents : 0), 0);
}

export function planRowSummary(row: PlanRow): string {
  if (row.skipped !== null) return row.skipped;
  if (row.wakes) return "Asleep";
  const parts = [
    ...(row.work !== null ? [`Uno Work ${row.work}`] : []),
    ...row.agents.map((agent) => `${agent.name} ${agent.target ?? ""}`.trim()),
  ];
  return parts.length > 0 ? parts.join(" · ") : "Up to date";
}

/**
 * Which boxes on the account belong in the list at all. An archived box, a box
 * that's being deleted or a plain server (not an Uno Work computer) can't be
 * updated from here: waking or pairing it only burns minutes (24.11: an
 * account with 17 archived boxes and a few build servers got a list of 20
 * and the run never reached the person's own computer).
 */
export function isUpdatableBox(box: {
  readonly status: string;
  readonly workMachine?: boolean | undefined;
}): boolean {
  if (box.workMachine === false) return false;
  const status = box.status.trim().toLowerCase();
  return (
    status === "running" ||
    status === "active" ||
    status === "on" ||
    status === "sleeping" ||
    status === "suspended" ||
    status === "paused" ||
    status === "hibernated" ||
    status === "stopped" ||
    status === "off"
  );
}

/**
 * Ticked when the list opens: computers that are on and have something to
 * update. A sleeping one stays as it is unless the person ticks it — waking
 * twenty machines for one click is what made "Update" hang.
 */
export function isSelectedByDefault(row: PlanRow): boolean {
  return planNeedsWork(row) && !row.wakes;
}

/** What a row says before the run, given whether it's ticked. */
export function planRowLine(row: PlanRow, selected: boolean): string {
  if (row.wakes) {
    return selected
      ? "Not open here now. Wakes up or connects to update"
      : "Not open here now. Its own Update shows when you open it";
  }
  return planRowSummary(row);
}

export type RowProgress =
  | { readonly kind: "waiting" }
  | { readonly kind: "working"; readonly step: string }
  /** `note` names the version the computer reports after the run. */
  | { readonly kind: "done"; readonly note: string }
  /** Asked to update once its agents finish: it does that by itself, the app can close. */
  | { readonly kind: "held"; readonly note: string }
  | { readonly kind: "failed"; readonly message: string };

export interface RunDeps {
  /** Wakes a sleeping computer and tells what it needs now. */
  readonly wake: (row: PlanRow) => Promise<Pick<PlanRow, "environmentId" | "work" | "agents">>;
  /** Resolves when the agent's install job ends; rejects with what went wrong. */
  readonly updateAgent: (environmentId: string, agent: AgentUpdateStatus) => Promise<void>;
  /**
   * Resolves `updated` when the computer is back on the new version, `waiting`
   * when it holds the update for its agents; rejects when it didn't work.
   */
  readonly updateWork: (environmentId: string) => Promise<"updated" | "waiting">;
  /** The Uno Work version the computer reports now; null when it can't tell. */
  readonly readVersion?: (environmentId: string) => Promise<string | null>;
  readonly onProgress: (key: string, progress: RowProgress) => void;
}

export interface RunLimits {
  /** Computers updated at the same time. */
  readonly concurrency: number;
  /** Waking and connecting one sleeping computer. */
  readonly wakeMs: number;
  /** One agent's install. */
  readonly agentMs: number;
  /** Uno Work's own update, restart included. */
  readonly workMs: number;
  /** Asking a computer its version at the end. */
  readonly versionMs: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  concurrency: 3,
  wakeMs: 3 * 60_000,
  agentMs: 11 * 60_000,
  // The updater's own limit is 30 min, two minutes is usual; past this the
  // row says so and the run moves on (the computer may still finish).
  workMs: 13 * 60_000,
  versionMs: 20_000,
};

export class StepTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepTimeoutError";
  }
}

/** A step that doesn't answer in time fails the row, never the whole run. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeoutError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "It didn't finish.";

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** "0.0.192" is at least "0.0.191"; anything unparsable compares as equal. */
function versionAtLeast(version: string, target: string): boolean {
  const parse = (value: string) => value.split(/[.-]/).slice(0, 3).map(Number);
  const a = parse(version);
  const b = parse(target);
  for (let index = 0; index < 3; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined || !Number.isFinite(left)) return true;
    if (!Number.isFinite(right)) return true;
    if (left !== right) return left > right;
  }
  return true;
}

async function runRow(row: PlanRow, deps: RunDeps, limits: RunLimits): Promise<void> {
  let current = row;
  try {
    if (row.wakes) {
      deps.onProgress(row.key, { kind: "working", step: "Waking up" });
      current = {
        ...row,
        ...(await withTimeout(
          deps.wake(row),
          limits.wakeMs,
          `Didn't wake up in ${minutes(limits.wakeMs)} min. Update it when you open it.`,
        )),
      };
    }
    const environmentId = current.environmentId;
    if (environmentId === null) throw new Error("Couldn't connect to this computer.");
    const failures: string[] = [];
    for (const agent of current.agents) {
      deps.onProgress(row.key, { kind: "working", step: `Updating ${agent.name}` });
      try {
        await withTimeout(
          deps.updateAgent(environmentId, agent),
          limits.agentMs,
          `didn't finish in ${minutes(limits.agentMs)} min.`,
        );
      } catch (error) {
        failures.push(`${agent.name}: ${messageOf(error)}`);
      }
    }
    let held = false;
    let workFailed = false;
    if (current.work !== null) {
      deps.onProgress(row.key, { kind: "working", step: "Updating Uno Work" });
      try {
        held =
          (await withTimeout(
            deps.updateWork(environmentId),
            limits.workMs,
            `no answer in ${minutes(limits.workMs)} min. It may still finish by itself.`,
          )) === "waiting";
      } catch (error) {
        workFailed = true;
        failures.push(`Uno Work: ${messageOf(error)}`);
      }
    }
    if (held && failures.length === 0) {
      deps.onProgress(row.key, { kind: "held", note: "Updates when its agents finish" });
      return;
    }
    // The honest end: what the computer itself says it runs now.
    if (!held && current.work !== null && deps.readVersion) {
      deps.onProgress(row.key, { kind: "working", step: "Checking the version" });
      const version = await withTimeout(
        deps.readVersion(environmentId),
        limits.versionMs,
        "no answer",
      ).catch(() => null);
      if (version !== null) {
        const reached = versionAtLeast(version, current.work);
        if (reached && workFailed) {
          // It went through after all (a slow restart): the version is the truth.
          failures.splice(
            failures.findIndex((entry) => entry.startsWith("Uno Work:")),
            1,
          );
        }
        if (failures.length > 0) {
          deps.onProgress(row.key, {
            kind: "failed",
            message: `${failures.join(" ")} Now on Uno Work ${version}.`,
          });
          return;
        }
        deps.onProgress(
          row.key,
          reached
            ? { kind: "done", note: `Updated · Uno Work ${version}` }
            : { kind: "failed", message: `Still on Uno Work ${version}. Try again in a minute.` },
        );
        return;
      }
    }
    if (failures.length > 0) {
      deps.onProgress(row.key, { kind: "failed", message: failures.join(" ") });
      return;
    }
    const updated = current.work !== null || current.agents.length > 0;
    const note = !updated
      ? "Up to date"
      : current.work !== null
        ? `Updated to Uno Work ${current.work}`
        : `Updated ${current.agents.map((agent) => agent.name).join(", ")}`;
    deps.onProgress(row.key, { kind: "done", note });
  } catch (error) {
    deps.onProgress(row.key, { kind: "failed", message: messageOf(error) });
  }
}

/**
 * A few computers at a time, each with its own time limits, so one that
 * doesn't answer fails its own row and the rest go on. The computer serving
 * this page goes last and alone: its restart takes the page's connection.
 */
export async function runUpdatePlan(
  rows: ReadonlyArray<PlanRow>,
  deps: RunDeps,
  limits: Partial<RunLimits> = {},
): Promise<void> {
  const effective = { ...DEFAULT_RUN_LIMITS, ...limits };
  const active = rows.filter(planNeedsWork);
  const others = active.filter((row) => !row.isPrimary);
  for (const row of active) deps.onProgress(row.key, { kind: "waiting" });
  let next = 0;
  const worker = async () => {
    while (next < others.length) {
      const row = others[next]!;
      next += 1;
      await runRow(row, deps, effective);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, effective.concurrency), others.length) }, worker),
  );
  for (const row of active.filter((entry) => entry.isPrimary)) {
    await runRow(row, deps, effective);
  }
}
