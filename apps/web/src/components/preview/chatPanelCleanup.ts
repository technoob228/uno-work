/**
 * Когда чистить правую панель чата (08.10, Миша): чат помечен Done, ушёл в
 * архив или удалён — всё, что было открыто «в этом чате», закрывается
 * (`dropChatBuckets`). Решаем по переходу, а не по состоянию: человек может
 * открыть Done-чат и посмотреть в нём файл — пока чат снова не отметят Done,
 * панель его не трогаем.
 *
 * Отметка чата — `archived:<время>` / `done:<время>` / null. Чистим, когда у
 * известного чата появилась новая отметка (Done после Done — это новое время
 * settle, тоже чистим). Чат, впервые увиденный уже закрытым (старт клиента,
 * подключение машины), не чистим: вкладок чата до старта не бывает — они не
 * сохраняются между запусками (`previewTabPersistence`).
 *
 * Удалённый чат = пропал из списка своей машины, а машина на месте и уже
 * загрузилась. Машина отключилась целиком — вкладки не трогаем: это может быть
 * обрыв связи, чаты вернутся.
 */

export interface ClosedChatThread {
  readonly id: string;
  readonly environmentId: string;
  readonly archivedAt: string | null;
  readonly settledOverride?: "settled" | "active" | null | undefined;
  readonly settledAt?: string | null | undefined;
}

export interface ClosedChatEnvironment {
  readonly environmentId: string;
  /** Список чатов машины уже пришёл целиком. */
  readonly loaded: boolean;
  readonly threads: ReadonlyArray<ClosedChatThread>;
}

/** Что запомнили о чате: машина и отметка «закрыт». */
export type ClosedChatMarks = ReadonlyMap<
  string,
  { readonly environmentId: string; readonly mark: string | null }
>;

export function chatClosedMark(thread: ClosedChatThread): string | null {
  if (thread.archivedAt !== null) return `archived:${thread.archivedAt}`;
  if (thread.settledOverride === "settled") return `done:${thread.settledAt ?? ""}`;
  return null;
}

/**
 * Следующий снимок отметок и чаты, панель которых надо почистить.
 * `previous === null` — первый снимок: только запоминаем.
 */
export function diffClosedChats(
  previous: ClosedChatMarks | null,
  environments: ReadonlyArray<ClosedChatEnvironment>,
): { readonly marks: ClosedChatMarks; readonly closed: ReadonlyArray<string> } {
  const marks = new Map<string, { environmentId: string; mark: string | null }>();
  const closed: string[] = [];
  const loadedEnvironments = new Set<string>();
  for (const environment of environments) {
    if (environment.loaded) loadedEnvironments.add(environment.environmentId);
    for (const thread of environment.threads) {
      const mark = chatClosedMark(thread);
      marks.set(thread.id, { environmentId: environment.environmentId, mark });
      if (previous === null || mark === null) continue;
      const before = previous.get(thread.id);
      if (before !== undefined && before.mark !== mark) closed.push(thread.id);
    }
  }
  if (previous !== null) {
    for (const [threadId, before] of previous) {
      if (marks.has(threadId)) continue;
      if (loadedEnvironments.has(before.environmentId)) closed.push(threadId);
      // Машина отключилась или ещё грузится — помним чат как был.
      else marks.set(threadId, before);
    }
  }
  return { marks, closed };
}
