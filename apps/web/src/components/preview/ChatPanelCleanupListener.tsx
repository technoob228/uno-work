import { useEffect, useRef } from "react";

import { useStore, type AppState } from "../../store";
import {
  diffClosedChats,
  type ClosedChatEnvironment,
  type ClosedChatMarks,
} from "./chatPanelCleanup";
import { usePreviewPane } from "./PreviewPaneContext";

/**
 * Чат помечен Done, ушёл в архив или удалён — правая панель этого чата
 * закрывается целиком (вкладки, браузер, превью сайтов, приложения). Работает
 * одинаково в вебе и в десктопе: на десктопе вместе с вкладками размонтируются
 * и их webview. Правила — `chatPanelCleanup.ts`.
 */
export function ChatPanelCleanupListener() {
  const { dropChats } = usePreviewPane();
  const dropRef = useRef(dropChats);
  dropRef.current = dropChats;

  useEffect(() => {
    let marks: ClosedChatMarks | null = null;
    // Стор меняется на каждое событие хода; список чатов — редко. Пересчёт —
    // только когда у какой-то машины сменился список или сводки чатов.
    let lastInputs: ReadonlyArray<unknown> = [];
    const observe = (state: AppState) => {
      const entries = Object.entries(state.environmentStateById);
      const inputs = entries.flatMap(([environmentId, env]) => [
        environmentId,
        env.bootstrapComplete,
        env.threadIds,
        env.sidebarThreadSummaryById,
      ]);
      if (
        marks !== null &&
        inputs.length === lastInputs.length &&
        inputs.every((value, index) => value === lastInputs[index])
      ) {
        return;
      }
      lastInputs = inputs;
      const environments: ClosedChatEnvironment[] = entries.map(([environmentId, env]) => ({
        environmentId,
        loaded: env.bootstrapComplete,
        threads: env.threadIds.flatMap((threadId) => {
          const thread = env.sidebarThreadSummaryById[threadId];
          return thread ? [thread] : [];
        }),
      }));
      const result = diffClosedChats(marks, environments);
      marks = result.marks;
      if (result.closed.length > 0) dropRef.current(result.closed);
    };
    observe(useStore.getState());
    return useStore.subscribe(observe);
  }, []);

  return null;
}
