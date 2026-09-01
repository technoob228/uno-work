/**
 * Фильтр таймлайна для встроенного чата (`EmbeddedThreadChat`).
 *
 * Чат всегда рендерит хост — плагин лишь просит показать его «потише». Поэтому
 * фильтр живёт здесь, на выборке строк таймлайна, а не в панели: плагин не
 * может ни добавить строку, ни расширить права.
 *
 * - `full` — обычный таймлайн;
 * - `answers-only` — только ответы: реплики пользователя, ответы ассистента с
 *   текстом и предложенные планы. Скрыт инструментальный шум (`work`-строки:
 *   команды, чтения файлов, статусы) и пустые заготовки ответа, пока модель
 *   ходит по инструментам. Approvals и вопросы-к-пользователю живут в композере
 *   (`ComposerPendingApprovalPanel` / `ComposerPendingUserInputPanel`), поэтому
 *   видны при любом значении;
 * - `composer-only` — таймлайна нет вовсе.
 */
import type { TimelineEntry } from "../../session-logic";

export const EMBEDDED_CHAT_VISIBILITIES = ["full", "answers-only", "composer-only"] as const;
export type EmbeddedChatVisibility = (typeof EMBEDDED_CHAT_VISIBILITIES)[number];

export function isEmbeddedChatVisibility(value: string): value is EmbeddedChatVisibility {
  return (EMBEDDED_CHAT_VISIBILITIES as ReadonlyArray<string>).includes(value);
}

/** Показывает ли этот режим таймлайн вообще. */
export function showsTimeline(visibility: EmbeddedChatVisibility): boolean {
  return visibility !== "composer-only";
}

function isAnswerEntry(entry: TimelineEntry): boolean {
  switch (entry.kind) {
    // Инструментальный шум — команды, патчи, статусы.
    case "work":
      return false;
    // План — это вопрос к пользователю, а не шум.
    case "proposed-plan":
      return true;
    case "message": {
      const { message } = entry;
      if (message.role === "user") return true;
      if (message.role !== "assistant") return false;
      // Пустая заготовка ответа появляется, пока модель ходит по инструментам.
      return message.text.trim().length > 0;
    }
  }
}

export function filterTimelineEntriesForVisibility(
  entries: TimelineEntry[],
  visibility: EmbeddedChatVisibility,
): TimelineEntry[] {
  switch (visibility) {
    case "full":
      return entries;
    case "composer-only":
      return [];
    case "answers-only":
      return entries.filter(isAnswerEntry);
  }
}
