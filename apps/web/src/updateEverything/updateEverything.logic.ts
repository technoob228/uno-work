/**
 * "Update everything": Uno Work and the agents on every computer of the person,
 * then this app. The pure half: what each computer needs, in what order it runs.
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
  if (row.wakes) return "Wakes up to check for updates";
  const parts = [
    ...(row.work !== null ? [`Uno Work ${row.work}`] : []),
    ...row.agents.map((agent) => `${agent.name} ${agent.target ?? ""}`.trim()),
  ];
  return parts.length > 0 ? parts.join(" · ") : "Up to date";
}

export type RowProgress =
  | { readonly kind: "waiting" }
  | { readonly kind: "working"; readonly step: string }
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
  readonly onProgress: (key: string, progress: RowProgress) => void;
}

const messageOf = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "It didn't finish.";

async function runRow(row: PlanRow, deps: RunDeps): Promise<void> {
  let current = row;
  try {
    if (row.wakes) {
      deps.onProgress(row.key, { kind: "working", step: "Waking up" });
      current = { ...row, ...(await deps.wake(row)) };
    }
    const environmentId = current.environmentId;
    if (environmentId === null) throw new Error("Couldn't connect to this computer.");
    const failures: string[] = [];
    for (const agent of current.agents) {
      deps.onProgress(row.key, { kind: "working", step: `Updating ${agent.name}` });
      try {
        await deps.updateAgent(environmentId, agent);
      } catch (error) {
        failures.push(`${agent.name}: ${messageOf(error)}`);
      }
    }
    let held = false;
    if (current.work !== null) {
      deps.onProgress(row.key, { kind: "working", step: "Updating Uno Work" });
      try {
        held = (await deps.updateWork(environmentId)) === "waiting";
      } catch (error) {
        failures.push(`Uno Work: ${messageOf(error)}`);
      }
    }
    if (failures.length > 0) {
      deps.onProgress(row.key, { kind: "failed", message: failures.join(" ") });
      return;
    }
    if (held) {
      deps.onProgress(row.key, { kind: "held", note: "Updates when its agents finish" });
      return;
    }
    const updated = current.work !== null || current.agents.length > 0;
    deps.onProgress(row.key, { kind: "done", note: updated ? "Updated" : "Up to date" });
  } catch (error) {
    deps.onProgress(row.key, { kind: "failed", message: messageOf(error) });
  }
}

/** Three computers at a time; the one serving this page last and alone. */
export async function runUpdatePlan(
  rows: ReadonlyArray<PlanRow>,
  deps: RunDeps,
  concurrency = 3,
): Promise<void> {
  const active = rows.filter(planNeedsWork);
  const others = active.filter((row) => !row.isPrimary);
  for (const row of active) deps.onProgress(row.key, { kind: "waiting" });
  let next = 0;
  const worker = async () => {
    while (next < others.length) {
      const row = others[next]!;
      next += 1;
      await runRow(row, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, others.length) }, worker));
  for (const row of active.filter((entry) => entry.isPrimary)) await runRow(row, deps);
}
