/**
 * `work_status` — the assistant's one-call answer to "what's the status?",
 * the pure half.
 *
 * One digest of the chats the assistant may see: the ones it handed work to
 * first (the started-chats ledger, the chats it is waiting on, the chats its
 * conversations started through the bridge), then the person's own chats
 * active in the last {@link MANAGER_WORK_STATUS_RECENT_HOURS} hours. Status
 * comes from {@link deriveAgentThreadStatus} (the sidebar's pill order) and
 * the turn rows; nothing here reads more than it is given.
 *
 * @module manager/workStatus
 */
import {
  MANAGER_WORK_STATUS_MAX_THREADS,
  MANAGER_WORK_STATUS_RECENT_HOURS,
  type ManagerWorkStatusState,
  type ManagerWorkStatusThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import { deriveAgentThreadStatus } from "../agentThreads/logic.ts";
import type { ProjectionTurn } from "../persistence/Services/ProjectionTurns.ts";
import { sanitizeUntrustedField, wrapUntrustedContent } from "../untrustedContent.ts";

/** The person's own chats in one answer, at most. */
export const WORK_STATUS_MAX_PERSON_THREADS = 8;
/** The assistant's own settled chats are listed this long after their last change. */
export const WORK_STATUS_OWN_RECENT_HOURS = 72;
/** The whole answer stays under this many characters (threads drop from the end). */
export const WORK_STATUS_MAX_CHARS = 6_000;
const STEP_CHARS = 80;
const ANSWER_CHARS = 160;
const HOUR_MS = 60 * 60_000;

export type WorkStatusShell = Pick<
  OrchestrationThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "updatedAt"
  | "archivedAt"
  | "session"
  | "latestTurn"
  | "latestUserMessageAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
>;

export interface WorkStatusCandidate {
  readonly shell: WorkStatusShell;
  readonly startedBy: "you" | "person";
}

export interface WorkStatusDetail {
  readonly projectTitle: string;
  readonly turns: ReadonlyArray<
    Pick<ProjectionTurn, "turnId" | "state" | "requestedAt" | "startedAt" | "completedAt">
  >;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "summary">>;
  readonly reportPending: boolean;
}

const toMs = (iso: string | null | undefined) => {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

const byRequestedDesc = (a: { requestedAt: string }, b: { requestedAt: string }) =>
  b.requestedAt.localeCompare(a.requestedAt);

/** running / needs_you / done / failed / stopped / idle — one word for the person. */
export function workStatusState(
  shell: WorkStatusShell,
  turns: WorkStatusDetail["turns"],
): ManagerWorkStatusState {
  switch (deriveAgentThreadStatus(shell)) {
    case "waiting":
      return "needs_you";
    case "running":
      return "running";
    case "error":
      return "failed";
    case "idle": {
      const latest = turns.filter((turn) => turn.turnId !== null).toSorted(byRequestedDesc)[0];
      if (latest === undefined) return "idle";
      if (latest.state === "interrupted") return "stopped";
      if (latest.state === "error") return "failed";
      return "done";
    }
  }
}

const isWorkActivity = (kind: string) => kind.startsWith("tool.") || kind.startsWith("task.");

function lastLine(messages: WorkStatusDetail["messages"]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const line = message.text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (line === undefined) continue;
    return line.length > ANSWER_CHARS ? `${line.slice(0, ANSWER_CHARS)}…` : line;
  }
  return null;
}

/** One row of the digest. */
export function workStatusRow(
  candidate: WorkStatusCandidate,
  detail: WorkStatusDetail,
  nowMs: number,
): ManagerWorkStatusThread {
  const { shell } = candidate;
  const status = workStatusState(shell, detail.turns);
  const sorted = detail.turns.toSorted(byRequestedDesc);
  const inflight = sorted.find((turn) => turn.state === "running" || turn.state === "pending");
  const runningSinceMs =
    status === "running"
      ? toMs(inflight?.startedAt ?? inflight?.requestedAt ?? shell.session?.updatedAt)
      : 0;
  const finished = sorted.find((turn) => turn.completedAt !== null);
  const step = detail.activities.findLast((activity) => isWorkActivity(activity.kind));
  const answer = lastLine(detail.messages);
  return {
    threadId: shell.id,
    title: sanitizeUntrustedField(shell.title, 120),
    project: sanitizeUntrustedField(detail.projectTitle, 80),
    startedBy: candidate.startedBy,
    status,
    runningForSec:
      status === "running" && runningSinceMs > 0
        ? Math.max(0, Math.round((nowMs - runningSinceMs) / 1_000))
        : null,
    finishedAt: status !== "running" && status !== "idle" ? (finished?.completedAt ?? null) : null,
    step: step === undefined ? null : sanitizeUntrustedField(step.summary, STEP_CHARS),
    lastAnswer: answer === null ? null : wrapUntrustedContent(answer),
    reportPending: detail.reportPending,
  };
}

/** A chat an assistant started on another computer, as the remote ledger last saw it. */
export interface RemoteWorkStatusEntry {
  readonly threadId: string;
  readonly title: string;
  readonly computerName: string;
  readonly startedAt: string;
  /** `ManagerRemoteChatStatus.state`. */
  readonly state: string;
  readonly lastMessage: string | null;
  readonly checkedAt: string | null;
}

const REMOTE_STATE: Readonly<Record<string, ManagerWorkStatusState>> = {
  running: "running",
  "waiting-for-you": "needs_you",
  done: "done",
  failed: "failed",
  stopped: "stopped",
  idle: "running",
};

/** One digest row for a chat on another computer. */
export function remoteWorkStatusRow(
  entry: RemoteWorkStatusEntry,
  input: { readonly nowMs: number; readonly reportPending: boolean },
): ManagerWorkStatusThread {
  const status = REMOTE_STATE[entry.state] ?? "running";
  const answer = lastLine([{ role: "assistant", text: entry.lastMessage ?? "" }]);
  return {
    threadId: entry.threadId as ManagerWorkStatusThread["threadId"],
    title: sanitizeUntrustedField(entry.title, 120),
    project: sanitizeUntrustedField(`on ${entry.computerName}`, 80),
    startedBy: "you",
    status,
    runningForSec:
      status === "running"
        ? Math.max(0, Math.round((input.nowMs - toMs(entry.startedAt)) / 1_000))
        : null,
    finishedAt: status !== "running" && status !== "idle" ? entry.checkedAt : null,
    step: null,
    lastAnswer: answer === null ? null : wrapUntrustedContent(answer),
    reportPending: input.reportPending,
    computer: sanitizeUntrustedField(entry.computerName, 80),
  };
}

/** Remote chats worth a row: still going, or settled within {@link WORK_STATUS_OWN_RECENT_HOURS}. */
export function pickRemoteWorkStatus(
  entries: ReadonlyArray<RemoteWorkStatusEntry>,
  nowMs: number,
): ReadonlyArray<RemoteWorkStatusEntry> {
  return entries.filter((entry) => {
    const live =
      entry.state === "running" || entry.state === "waiting-for-you" || entry.state === "idle";
    const last = toMs(entry.checkedAt ?? entry.startedAt);
    return live
      ? nowMs - toMs(entry.startedAt) < 24 * HOUR_MS
      : nowMs - last < WORK_STATUS_OWN_RECENT_HOURS * HOUR_MS;
  });
}

const STATUS_RANK: Readonly<Record<ManagerWorkStatusState, number>> = {
  needs_you: 0,
  running: 1,
  failed: 2,
  done: 3,
  stopped: 4,
  idle: 5,
};

const isLive = (shell: WorkStatusShell) => shell.archivedAt === null;
const isBusy = (shell: WorkStatusShell) => {
  const state = deriveAgentThreadStatus(shell);
  return state === "running" || state === "waiting";
};
const newestFirst = (a: WorkStatusShell, b: WorkStatusShell) =>
  b.updatedAt.localeCompare(a.updatedAt);

/**
 * Which chats the digest looks at, in order: the assistant's own (recent or
 * still busy), then the person's recently active ones, capped. `busy` is a
 * cheap first look (session / pending flags) before anything is read.
 */
export function pickWorkStatusCandidates(input: {
  readonly own: ReadonlyArray<WorkStatusShell>;
  readonly person: ReadonlyArray<WorkStatusShell>;
  readonly nowMs: number;
}): { readonly picked: ReadonlyArray<WorkStatusCandidate>; readonly omitted: number } {
  const recent = (shell: WorkStatusShell, hours: number) =>
    input.nowMs - toMs(shell.updatedAt) < hours * HOUR_MS;
  const ownIds = new Set(input.own.map((shell) => shell.id));
  const own = input.own
    .filter(
      (shell) => isLive(shell) && (isBusy(shell) || recent(shell, WORK_STATUS_OWN_RECENT_HOURS)),
    )
    .toSorted((a, b) => Number(isBusy(b)) - Number(isBusy(a)) || newestFirst(a, b));
  const person = input.person
    .filter(
      (shell) =>
        isLive(shell) && !ownIds.has(shell.id) && recent(shell, MANAGER_WORK_STATUS_RECENT_HOURS),
    )
    .toSorted(newestFirst);
  const ownTaken = own.slice(0, MANAGER_WORK_STATUS_MAX_THREADS);
  const personTaken = person.slice(
    0,
    Math.min(WORK_STATUS_MAX_PERSON_THREADS, MANAGER_WORK_STATUS_MAX_THREADS - ownTaken.length),
  );
  return {
    picked: [
      ...ownTaken.map((shell) => ({ shell, startedBy: "you" as const })),
      ...personTaken.map((shell) => ({ shell, startedBy: "person" as const })),
    ],
    omitted: own.length - ownTaken.length + (person.length - personTaken.length),
  };
}

/** Order the rows (own first; within, what needs attention first) and keep the answer short. */
export function finishWorkStatus(
  rows: ReadonlyArray<ManagerWorkStatusThread>,
  omitted: number,
): { readonly threads: ReadonlyArray<ManagerWorkStatusThread>; readonly omitted: number } {
  const ordered = rows.toSorted(
    (a, b) =>
      Number(a.startedBy === "person") - Number(b.startedBy === "person") ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status],
  );
  const kept: Array<ManagerWorkStatusThread> = [];
  let size = 0;
  for (const row of ordered) {
    const rowSize = JSON.stringify(row).length;
    if (kept.length > 0 && size + rowSize > WORK_STATUS_MAX_CHARS) break;
    kept.push(row);
    size += rowSize;
  }
  return { threads: kept, omitted: omitted + (ordered.length - kept.length) };
}
