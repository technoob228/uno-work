/**
 * Данные вкладки «Tasks/Plan» правой панели, по тредам.
 *
 * План (шаги с статусами) и предложенный план выводит ChatView — из активностей
 * треда, последнего хода, каталога планов (в т.ч. плана из исходного треда при
 * «Implement in a new thread») и режима композера. Правая панель живёт вне
 * ChatView (AppSidebarLayout), поэтому основной чат публикует уже выведенный
 * результат сюда, а тело вкладки читает его по threadId. Так у кнопки в
 * композере и у вкладки один источник правды, без второго вывода тех же данных.
 *
 * Вкладка задач — только уровня чата (см. `isTasksTab` и меню уровней в
 * PreviewPane): видна, только пока этот тред — основной чат на экране, а
 * значит, его ChatView смонтирован и держит запись свежей.
 */

import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import type { ActivePlanState, LatestProposedPlanState } from "../../session-logic";

export interface ThreadTasksSnapshot {
  readonly activePlan: ActivePlanState | null;
  readonly proposedPlan: LatestProposedPlanState | null;
  /** "Plan" в режиме плана или при предложенном плане, иначе "Tasks". */
  readonly label: string;
  readonly environmentId: EnvironmentId;
  readonly markdownCwd: string | undefined;
  readonly workspaceRoot: string | undefined;
}

export type ThreadTasksSnapshots = Readonly<Record<string, ThreadTasksSnapshot>>;

function sameSnapshot(a: ThreadTasksSnapshot, b: ThreadTasksSnapshot): boolean {
  return (
    a.activePlan === b.activePlan &&
    a.proposedPlan === b.proposedPlan &&
    a.label === b.label &&
    a.environmentId === b.environmentId &&
    a.markdownCwd === b.markdownCwd &&
    a.workspaceRoot === b.workspaceRoot
  );
}

/** Чистый переход: записать снимок треда (тот же — ссылка на состояние не меняется). */
export function putThreadTasksSnapshot(
  snapshots: ThreadTasksSnapshots,
  threadId: string,
  snapshot: ThreadTasksSnapshot,
): ThreadTasksSnapshots {
  const current = snapshots[threadId];
  if (current && sameSnapshot(current, snapshot)) return snapshots;
  return { ...snapshots, [threadId]: snapshot };
}

/** Чистый переход: забыть снимок треда (чат ушёл с экрана). */
export function dropThreadTasksSnapshot(
  snapshots: ThreadTasksSnapshots,
  threadId: string,
): ThreadTasksSnapshots {
  if (!(threadId in snapshots)) return snapshots;
  const { [threadId]: _removed, ...rest } = snapshots;
  return rest;
}

const useThreadTasksStore = create<{ snapshots: ThreadTasksSnapshots }>(() => ({
  snapshots: {},
}));

export function publishThreadTasks(threadId: string, snapshot: ThreadTasksSnapshot): void {
  const { snapshots } = useThreadTasksStore.getState();
  const next = putThreadTasksSnapshot(snapshots, threadId, snapshot);
  if (next !== snapshots) useThreadTasksStore.setState({ snapshots: next });
}

export function clearThreadTasks(threadId: string): void {
  const { snapshots } = useThreadTasksStore.getState();
  const next = dropThreadTasksSnapshot(snapshots, threadId);
  if (next !== snapshots) useThreadTasksStore.setState({ snapshots: next });
}

export function useThreadTasks(threadId: string | null): ThreadTasksSnapshot | null {
  return useThreadTasksStore((store) => (threadId ? (store.snapshots[threadId] ?? null) : null));
}
