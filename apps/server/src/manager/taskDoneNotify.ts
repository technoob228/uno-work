/**
 * "Your agent finished" — the pure half (agent-flow pass 25.10, item 9).
 *
 * The person gives an agent a long task, closes the laptop and nobody tells
 * them it is done: the agent's `notify` lands in the Inbox inside Uno Work,
 * which they don't have open. Now, when a task the person started in the app
 * ends after {@link TASK_DONE_MIN_MS} or more and no Uno Work tab is open at
 * that moment, Uno's own bot tells them in Telegram (or, without a linked
 * Telegram, the console mails the account address).
 *
 * {@link trackTaskDone} folds the orchestration events: a person's message
 * starts a task; the server's own continuations (the turn auto-retry, origin
 * `system`) keep it going; a turn that ends `ready` after running closes it.
 * One notice per task: the task is dropped once it ends, long or not.
 * Turns from a connected chat, another agent, an app or the assistant are not
 * tasks here — they have their own way back.
 *
 * @module manager/taskDoneNotify
 */
import type {
  OrchestrationCommandOrigin,
  OrchestrationEvent,
  OrchestrationSessionStatus,
  ThreadId,
} from "@t3tools/contracts";

/** Shorter tasks: the person is most likely still looking. */
export const TASK_DONE_MIN_MS = 2 * 60_000;

/** Where the person opens Uno Work from a phone or another computer. */
export const UNO_WORK_OPEN_URL = "https://app.uno4.work";

export interface TaskDoneState {
  /** Open tasks: when the person's message that started it came in. */
  readonly tasks: ReadonlyMap<ThreadId, number>;
  readonly sessionStatus: ReadonlyMap<ThreadId, OrchestrationSessionStatus>;
}

export const INITIAL_TASK_DONE_STATE: TaskDoneState = {
  tasks: new Map(),
  sessionStatus: new Map(),
};

export interface TaskDone {
  readonly threadId: ThreadId;
  readonly durationMs: number;
}

const eventTimeMs = (event: OrchestrationEvent): number => {
  const at = Date.parse(event.occurredAt);
  return Number.isFinite(at) ? at : Date.now();
};

/** A person in the app (no origin): the only start of a task we tell about. */
const isPersonInApp = (origin: OrchestrationCommandOrigin | undefined) => origin === undefined;

export const trackTaskDone = (
  state: TaskDoneState,
  event: OrchestrationEvent,
): { readonly state: TaskDoneState; readonly done: TaskDone | null } => {
  switch (event.type) {
    case "thread.turn-start-requested": {
      const { threadId } = event.payload;
      const origin = event.metadata.origin;
      if (isPersonInApp(origin)) {
        // A new message from the person starts a new task (and its clock).
        const tasks = new Map(state.tasks);
        tasks.set(threadId, eventTimeMs(event));
        return { state: { ...state, tasks }, done: null };
      }
      // The server continuing the person's task (auto-retry after a model
      // failure) keeps it; anyone else (a chat, an agent, an app) takes over.
      if (origin.kind === "system" || !state.tasks.has(threadId)) {
        return { state, done: null };
      }
      const tasks = new Map(state.tasks);
      tasks.delete(threadId);
      return { state: { ...state, tasks }, done: null };
    }
    case "thread.session-set": {
      const { threadId, session } = event.payload;
      const previous = state.sessionStatus.get(threadId);
      const sessionStatus = new Map(state.sessionStatus);
      sessionStatus.set(threadId, session.status);
      const next: TaskDoneState = { ...state, sessionStatus };
      const ended =
        previous === "running" && session.status === "ready" && session.activeTurnId === null;
      const startedAt = state.tasks.get(threadId);
      if (!ended || startedAt === undefined) return { state: next, done: null };
      const tasks = new Map(state.tasks);
      tasks.delete(threadId);
      const durationMs = Math.max(0, eventTimeMs(event) - startedAt);
      return {
        state: { ...next, tasks },
        done: durationMs >= TASK_DONE_MIN_MS ? { threadId, durationMs } : null,
      };
    }
    case "thread.deleted":
    case "thread.archived": {
      const { threadId } = event.payload;
      const tasks = new Map(state.tasks);
      const sessionStatus = new Map(state.sessionStatus);
      tasks.delete(threadId);
      sessionStatus.delete(threadId);
      return { state: { tasks, sessionStatus }, done: null };
    }
    default:
      return { state, done: null };
  }
};

/** "3 min", "1 h 05 min". */
export const formatTaskDuration = (durationMs: number): string => {
  const minutes = Math.max(1, Math.round(durationMs / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, "0")} min`;
};

const TITLE_MAX_CHARS = 80;

const shortTitle = (title: string): string => {
  const line = title.replace(/\s+/g, " ").trim();
  return line.length <= TITLE_MAX_CHARS ? line : `${line.slice(0, TITLE_MAX_CHARS - 1)}…`;
};

/**
 * The message (Telegram via Uno's bot — the console puts "From your Uno
 * computer" above it — or the email body). Wording waits for Misha's OK.
 */
export const formatTaskDoneText = (input: {
  readonly threadTitle: string;
  readonly durationMs: number;
}): string =>
  `Your agent finished "${shortTitle(input.threadTitle)}" (${formatTaskDuration(input.durationMs)}). ` +
  `Open Uno Work to see the result: ${UNO_WORK_OPEN_URL}`;

/** The email subject when there is no Telegram to send it to. */
export const formatTaskDoneEmailSubject = (threadTitle: string): string =>
  `Your agent finished: ${shortTitle(threadTitle)}`;
