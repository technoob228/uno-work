/**
 * Pult state in the client: the board data (from the tracker; in the demo —
 * fixtures), what the owner did here (answers, manual order and priority), the
 * open task and screen. The answers also go to the chat as a message (pultBridge).
 */
import { create } from "zustand";

import type { PultData, PultTask } from "./pult.types";
import type { PultView } from "./pult.logic";

export interface PultAnswerMark {
  readonly label: string;
  readonly at: number;
}

interface PultState {
  readonly data: PultData | null;
  /** Task open in the Pult (level 2), or null for the board. */
  readonly openTaskId: string | null;
  readonly view: PultView;
  /** The owner answered here: task → the chosen option / "done". */
  readonly answers: Readonly<Record<string, PultAnswerMark>>;
  /** Manual order: task ids top to bottom (missing ones keep their rank). */
  readonly order: ReadonlyArray<string>;
  readonly priority: Readonly<Record<string, PultTask["priority"]>>;
  /** A question handed to the dispatcher from elsewhere (a screenshot "send to Pult", a shortcut). */
  readonly handoff: { readonly text: string; readonly shots: number; readonly at: number } | null;
  readonly askDispatcher: (text: string, shots?: number) => void;
  readonly load: (data: PultData) => void;
  readonly openTask: (id: string | null) => void;
  readonly setView: (view: PultView) => void;
  readonly answer: (taskId: string, label: string) => void;
  readonly undoAnswer: (taskId: string) => void;
  readonly move: (taskId: string, before: string | null) => void;
  readonly setPriority: (taskId: string, priority: PultTask["priority"]) => void;
}

export const usePultStore = create<PultState>((set, get) => ({
  data: null,
  openTaskId: null,
  view: "board",
  answers: {},
  order: [],
  priority: {},
  handoff: null,
  askDispatcher: (text, shots = 0) => set({ handoff: { text, shots, at: Date.now() }, openTaskId: null, view: "board" }),
  load: (data) => set({ data, order: data.tasks.toSorted((a, b) => a.rank - b.rank).map((t) => t.id) }),
  openTask: (openTaskId) => set({ openTaskId, ...(openTaskId ? { view: "board" as const } : {}) }),
  setView: (view) => set({ view, openTaskId: null }),
  answer: (taskId, label) => set({ answers: { ...get().answers, [taskId]: { label, at: Date.now() } } }),
  undoAnswer: (taskId) => {
    const { [taskId]: _gone, ...rest } = get().answers;
    set({ answers: rest });
  },
  move: (taskId, before) => {
    const order = get().order.filter((id) => id !== taskId);
    const at = before ? order.indexOf(before) : order.length;
    order.splice(at < 0 ? order.length : at, 0, taskId);
    set({ order });
  },
  setPriority: (taskId, p) => set({ priority: { ...get().priority, [taskId]: p } }),
}));

/**
 * The tasks as the owner sees them now: manual order as rank, manual priority,
 * and an answered request no longer waits for them (the task goes back to work).
 */
export function effectiveTasks(state: Pick<PultState, "data" | "answers" | "order" | "priority">): PultTask[] {
  if (!state.data) return [];
  const rankOf = new Map(state.order.map((id, i) => [id, i + 1]));
  return state.data.tasks.map((t) => {
    const answered = state.answers[t.id];
    const { needs: _needs, ...withoutNeeds } = t;
    const base: PultTask = answered ? { ...withoutNeeds, status: t.status === "needs_you" ? "doing" : t.status } : t;
    return {
      ...base,
      rank: rankOf.get(t.id) ?? t.rank,
      priority: state.priority[t.id] ?? t.priority,
    };
  });
}
