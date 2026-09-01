/**
 * `EmbeddedThreadChat` — хост-чат, встроенный в чужую поверхность (сегодня —
 * рядом с панелью плагина, `PreviewPane`).
 *
 * Чат всегда рендерит хост: плагин получает его как примитив с параметрами и не
 * может ни нарисовать своё сообщение, ни расширить права треда (`variant`,
 * `visibility`, `composer` — только сужают).
 *
 * КОМПРОМИСС (зафиксирован в `.plans/20-plugin-panels-custom-ai-ui.md`, фаза C1):
 * внутри монтируется существующий `ChatView` с флагом `embedded`, а не
 * вытащенная из него пара «таймлайн + композер». `ChatView` — одна функция на
 * ~3.5к строк, где вся обвязка композера (60+ пропсов: отправка, approvals,
 * вопросы-к-пользователю, планы, модели, дродпы) вычисляется на месте; вынести
 * её отдельным компонентом = переписать чат целиком и рискнуть основным
 * маршрутом. Поэтому переиспользуется весь ChatView, а `embedded` гасит в нём
 * chrome и те побочные эффекты, которые обязаны быть в одном экземпляре на
 * документ: глобальные хоткеи, контекст правой панели, терминалы, общий ref
 * композера, plan sidebar, BranchToolbar, фокус-режим.
 *
 * Данные при этом бесплатны: `ChatView` сам держит подписку на детали треда
 * (`retainThreadDetailSubscription`), поэтому встроенный чат работает с любым
 * тредом, а не только с тем, что открыт в маршруте.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import ChatView from "../ChatView";
import type { EmbeddedChatVisibility } from "./embeddedChatVisibility";

export interface EmbeddedThreadChatProps {
  readonly threadRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  /** Сейчас поддержан один вариант; параметр оставлен для будущих раскладок. */
  readonly variant?: "compact";
  readonly visibility?: EmbeddedChatVisibility;
  /** Показывать ли ввод. Approvals и вопросы живут в композере. */
  readonly composer?: boolean;
}

export function EmbeddedThreadChat({
  threadRef,
  visibility = "full",
  composer = true,
}: EmbeddedThreadChatProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <ChatView
        key={`${threadRef.environmentId}:${threadRef.threadId}`}
        environmentId={threadRef.environmentId}
        threadId={threadRef.threadId}
        routeKind="server"
        embedded={{ visibility, composer }}
      />
    </div>
  );
}
