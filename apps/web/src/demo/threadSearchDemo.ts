/**
 * Message search and goals in the demo: the computer's answers, from the demo
 * chats. Matching uses the shared helpers, so the page behaves like the server.
 */
import {
  ORCHESTRATION_WS_METHODS,
  THREAD_GOAL_ACTIVITY_KIND,
  type ThreadGoalState,
} from "@t3tools/contracts";
import {
  buildThreadSearchSnippet,
  countThreadSearchOccurrences,
  messageSearchGrader,
  threadSearchVisibleText,
} from "@t3tools/shared/threadSearch";
import { GOAL_MAX_COST_USD, GOAL_MAX_MINUTES, GOAL_MAX_TURNS } from "@t3tools/shared/threadGoal";

interface DemoMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

interface DemoThread {
  readonly id: string;
  readonly projectId: string;
  readonly messages: ReadonlyArray<DemoMessage>;
  readonly activities: unknown[];
}

const asDemoThreads = (threads: ReadonlyArray<unknown>) =>
  threads as ReadonlyArray<DemoThread & { readonly deletedAt?: string | null }>;

function searchThreads(threads: ReadonlyArray<unknown>, query: string) {
  const grade = messageSearchGrader(query);
  const matches = asDemoThreads(threads).flatMap((thread) => {
    if (thread.deletedAt) return [];
    const hits = thread.messages.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const text = threadSearchVisibleText(message.text);
      const graded = grade(text);
      return graded === null ? [] : [{ message, text, ...graded }];
    });
    const best = hits.toSorted(
      (left, right) =>
        right.quality - left.quality ||
        right.message.createdAt.localeCompare(left.message.createdAt),
    )[0];
    if (!best) return [];
    return [
      {
        threadId: thread.id,
        projectId: thread.projectId,
        messageId: best.message.id,
        source: best.message.role,
        snippet: buildThreadSearchSnippet(best.text, best.offset),
        messageCreatedAt: best.message.createdAt,
        quality: best.quality,
        hits: hits.length,
      },
    ];
  });
  return {
    matches: matches.toSorted(
      (left, right) =>
        right.quality - left.quality || right.messageCreatedAt.localeCompare(left.messageCreatedAt),
    ),
    indexing: false,
  };
}

function findInThread(threads: ReadonlyArray<unknown>, threadId: unknown, query: string) {
  const thread = asDemoThreads(threads).find((candidate) => candidate.id === threadId);
  let totalMatches = 0;
  const entries = (thread?.messages ?? []).flatMap((message) => {
    const count = countThreadSearchOccurrences(threadSearchVisibleText(message.text), query);
    if (count === 0) return [];
    const startIndex = totalMatches;
    totalMatches += count;
    return [{ messageId: message.id, count, startIndex }];
  });
  return { totalMatches, entries };
}

const goalActivity = (state: ThreadGoalState) => ({
  id: `demo-goal-${state.goalId}-${state.status}`,
  tone: "info",
  kind: THREAD_GOAL_ACTIVITY_KIND,
  summary: "Goal updated",
  payload: state,
  turnId: null,
  createdAt: new Date().toISOString(),
});

const latestGoal = (thread: DemoThread) =>
  (thread.activities as Array<{ kind?: string; payload?: ThreadGoalState }>)
    .filter((activity) => activity.kind === THREAD_GOAL_ACTIVITY_KIND)
    .at(-1)?.payload;

function setGoal(thread: DemoThread, goal: string): ThreadGoalState {
  const now = Date.now();
  const state: ThreadGoalState = {
    goalId: `goal-${now}`,
    goal,
    status: "active",
    turnsUsed: 1,
    maxTurns: GOAL_MAX_TURNS,
    costUsd: 0.42,
    maxCostUsd: GOAL_MAX_COST_USD,
    startedAt: new Date(now).toISOString() as ThreadGoalState["startedAt"],
    deadlineAt: new Date(
      now + GOAL_MAX_MINUTES * 60_000,
    ).toISOString() as ThreadGoalState["deadlineAt"],
    endNote: null,
    lastTurnId: null,
  };
  thread.activities.push(goalActivity(state));
  return state;
}

function stopGoal(thread: DemoThread) {
  const current = latestGoal(thread);
  if (current?.status !== "active") return { stopped: false };
  thread.activities.push(
    goalActivity({ ...current, status: "stopped", endNote: "You stopped this goal." }),
  );
  return { stopped: true };
}

/** `undefined` when the call is not about search or goals. */
export function answerThreadSearchRpc(
  threads: ReadonlyArray<unknown>,
  tag: string,
  body: Record<string, unknown>,
  publish: (threadId: string) => void,
): unknown {
  const thread = asDemoThreads(threads).find((candidate) => candidate.id === body.threadId);
  switch (tag) {
    case ORCHESTRATION_WS_METHODS.searchThreads:
      return searchThreads(threads, String(body.query ?? ""));
    case ORCHESTRATION_WS_METHODS.findInThread:
      return findInThread(threads, body.threadId, String(body.query ?? ""));
    case ORCHESTRATION_WS_METHODS.setThreadGoal: {
      if (!thread) return undefined;
      const state = setGoal(thread, String(body.goal ?? ""));
      publish(thread.id);
      return state;
    }
    case ORCHESTRATION_WS_METHODS.stopThreadGoal: {
      if (!thread) return undefined;
      const result = stopGoal(thread);
      publish(thread.id);
      return result;
    }
    default:
      return undefined;
  }
}
