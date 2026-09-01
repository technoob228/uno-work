/**
 * Локальная шина событий оркестрации для потребителей вне стора.
 *
 * Поток `subscribeShell` у клиента уже есть — он приезжает по WS и применяется
 * к стору (`runtime/service.ts`). Панельным плагинам нужны те же события, но
 * стор их «сплющивает» в состояние. Поэтому после применения события мы
 * публикуем его как есть; подписчики (мост панели) фильтруют сами.
 *
 * Наблюдение только: подписчик не может ничего отменить или задержать, а его
 * исключение не ломает применение события.
 */
import type { EnvironmentId, OrchestrationShellStreamEvent, ProjectId } from "@t3tools/contracts";

export interface ShellEventNotice {
  readonly event: OrchestrationShellStreamEvent;
  readonly environmentId: EnvironmentId;
  /**
   * Проект удалённого треда: в событии `thread-removed` его нет, а из стора
   * после применения он уже пропал — поэтому публикатор передаёт его отдельно.
   */
  readonly removedThreadProjectId: ProjectId | null;
}

type ShellEventListener = (notice: ShellEventNotice) => void;

const listeners = new Set<ShellEventListener>();

export function subscribeShellEvents(listener: ShellEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishShellEvent(notice: ShellEventNotice): void {
  for (const listener of listeners) {
    try {
      listener(notice);
    } catch (error) {
      console.error("shell event listener failed", error);
    }
  }
}
