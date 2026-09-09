/**
 * Уровни вкладок правой панели.
 *
 * Вкладка (файл, страница браузера или панель плагина) живёт на одном из трёх
 * уровней:
 *
 * - `chat` — вкладки конкретного треда. Уровень по умолчанию: и для того, что
 *   открывает пользователь, и для того, что открывает агент. Переход в другой
 *   чат убирает их из виду, не закрывая.
 * - `project` — вкладки уровня проекта: видны в любом чате этого проекта
 *   (high-level review, дашборд проекта).
 * - `global` — видны всегда, в каком бы проекте пользователь ни был.
 *
 * Уровень задаётся не полем в самой вкладке, а тем, в каком бакете она лежит:
 * бакеты адресуются scope-ключом, и один и тот же id не может оказаться в двух
 * бакетах. Перемещение между уровнями = перенос вкладки между бакетами.
 */

export type PreviewTabScope = "chat" | "project" | "global";

export const PREVIEW_TAB_SCOPES: ReadonlyArray<PreviewTabScope> = ["global", "project", "chat"];

/** Единственный глобальный бакет: не зависит ни от проекта, ни от треда. */
export const GLOBAL_SCOPE_KEY = "global";

const PROJECT_SCOPE_PREFIX = "project:";
const CHAT_SCOPE_PREFIX = "chat:";

export function projectScopeKey(projectKey: string): string {
  return `${PROJECT_SCOPE_PREFIX}${projectKey}`;
}

export function chatScopeKey(threadId: string): string {
  return `${CHAT_SCOPE_PREFIX}${threadId}`;
}

/** Уровень, которому принадлежит бакет. Неизвестный формат считаем проектным. */
export function scopeOfKey(scopeKey: string): PreviewTabScope {
  if (scopeKey === GLOBAL_SCOPE_KEY) return "global";
  if (scopeKey.startsWith(CHAT_SCOPE_PREFIX)) return "chat";
  return "project";
}

/** Куда открывать вкладку: проект и (если есть) тред-источник. */
export interface PreviewTabTarget {
  readonly projectKey: string;
  readonly threadId: string | null;
}

/**
 * Scope-ключ бакета для уровня. `chat` без известного треда деградирует до
 * проектного уровня: иначе вкладка попала бы в бакет, который никогда не
 * показывается.
 */
export function scopeKeyForTarget(target: PreviewTabTarget, scope: PreviewTabScope): string {
  if (scope === "global") return GLOBAL_SCOPE_KEY;
  if (scope === "chat" && target.threadId) return chatScopeKey(target.threadId);
  return projectScopeKey(target.projectKey);
}

/**
 * Бакеты, видимые в текущем контексте, в порядке отображения в ряду вкладок:
 * сначала «постоянные» (global → project), потом вкладки самого чата.
 */
export function visibleScopeKeys(target: PreviewTabTarget): ReadonlyArray<string> {
  const keys = [GLOBAL_SCOPE_KEY, projectScopeKey(target.projectKey)];
  if (target.threadId) keys.push(chatScopeKey(target.threadId));
  return keys;
}

/**
 * Бакеты для исполнения команд автоматизации — обратный порядок: агент правит
 * вкладку своего чата, и только если её нет — проектную или глобальную.
 */
export function automationScopeKeys(target: PreviewTabTarget): ReadonlyArray<string> {
  return visibleScopeKeys(target).toReversed();
}

/**
 * Бакет, который держит состояние вида (открыта ли панель, активная вкладка,
 * режим фокуса) — проектный. Так переключение тредов внутри проекта не
 * закрывает панель и не сбрасывает раскладку.
 */
export function viewScopeKey(target: PreviewTabTarget): string {
  return projectScopeKey(target.projectKey);
}

/** Человекочитаемое название уровня — для тултипов и меню. */
export const SCOPE_LABEL: Record<PreviewTabScope, string> = {
  chat: "этот чат",
  project: "проект",
  global: "везде",
};

export const SCOPE_MENU_LABEL: Record<PreviewTabScope, string> = {
  chat: "Оставить только в этом чате",
  project: "Держать на уровне проекта",
  global: "Держать открытой везде",
};
