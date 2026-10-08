/**
 * Модель правой панели: в каких бакетах лежат вкладки и как выглядит панель в
 * каждом контексте. Чистые функции `(states, …) → states` — их зовёт
 * `PreviewPaneContext` и проверяют юнит-тесты.
 *
 * Правила (02.10, Миша: «что агент открыл в чате — живёт в этом чате»):
 *
 * 1. Вид панели (открыта ли, активная вкладка, фокус, ширина, бейдж) — у
 *    каждого чата свой: он лежит в бакете `chat:<threadId>`. Вне чата вид
 *    держит глобальный бакет, и видны там только вкладки «везде».
 * 2. Чат, где панель ещё ни разу не трогали, наследует «открыто» у
 *    закреплённых везде вкладок — если они есть и показаны. Иначе панель
 *    закрыта.
 * 3. Человек закрыл панель в чате → агент её больше не распахивает: вкладка
 *    добавляется, на кнопке панели в шапке чата загорается бейдж. Открыл
 *    человек — бейдж гаснет, агент снова может показывать.
 */

import {
  chatScopeKey,
  GLOBAL_SCOPE_KEY,
  scopeKeyForTarget,
  scopeOfKey,
  viewScopeKey,
  visibleScopeKeys,
  type PreviewTabScope,
  type PreviewTabTarget,
} from "./previewTabScopes";
// Только типы: значения из PreviewPaneContext здесь импортировать нельзя —
// контекст сам импортирует этот модуль.
import type { BrowserContext, PreviewFile } from "./PreviewPaneContext";

/** Кто открывает вкладку: человек — всегда показываем; агент — если панель не закрыта человеком. */
export type PanelOpenSource = "person" | "agent";

/**
 * Бакет одного уровня (`previewTabScopes`): вкладки уровня плюс, для бакетов
 * вида (`viewScopeKey` — чат или глобальный), состояние панели этого контекста.
 */
export interface PreviewBucketState {
  open: boolean;
  previewLayoutMode: "sidebar" | "focus";
  files: ReadonlyArray<PreviewFile>;
  activeFileId: string | null;
  browserOpen: boolean;
  browserContext: BrowserContext;
  editingFileId: string | null;
  /** Файлы, показанные как исходный код вместо превью (для DUAL_VIEW_KINDS). */
  sourceViewFileIds: ReadonlyArray<string>;
  /** Панель в этом контексте уже открывали/закрывали — `open` действует сам, без наследования. */
  viewTouched: boolean;
  /** Человек закрыл панель здесь: агент вкладки добавляет, но панель не распахивает. */
  dismissed: boolean;
  /** Сколько вкладок агент добавил, пока панель была закрыта человеком (бейдж в шапке). */
  unseen: number;
  /** Ширина панели в этом контексте; null — общая ширина по умолчанию. */
  width: number | null;
}

export const EMPTY_BROWSER_CONTEXT: BrowserContext = { environmentId: null, startPath: null };

export const DEFAULT_PREVIEW_BUCKET_STATE: PreviewBucketState = {
  open: false,
  previewLayoutMode: "sidebar",
  files: [],
  activeFileId: null,
  browserOpen: false,
  browserContext: EMPTY_BROWSER_CONTEXT,
  editingFileId: null,
  sourceViewFileIds: [],
  viewTouched: false,
  dismissed: false,
  unseen: 0,
  width: null,
};

export type PreviewStates = Readonly<Record<string, PreviewBucketState>>;

export function getPreviewBucketState(states: PreviewStates, key: string): PreviewBucketState {
  return states[key] ?? DEFAULT_PREVIEW_BUCKET_STATE;
}

export function applyPreviewBucketPatch(
  states: PreviewStates,
  key: string,
  patch: Partial<PreviewBucketState>,
): Record<string, PreviewBucketState> {
  const current = getPreviewBucketState(states, key);
  return {
    ...states,
    [key]: { ...current, ...patch },
  };
}

/**
 * Бакет, в котором лежит вкладка. `preferredKeys` (обычно — видимые сейчас
 * бакеты) просматриваются первыми: один и тот же файл может быть открыт в
 * бакетах двух разных чатов, и закрывать/переносить надо ту копию, которую
 * пользователь видит, а не чужую. null — такой вкладки нет нигде.
 */
export function findTabScopeKey(
  states: PreviewStates,
  id: string,
  preferredKeys: ReadonlyArray<string> = [],
): string | null {
  for (const scopeKey of preferredKeys) {
    if (states[scopeKey]?.files.some((file) => file.id === id)) return scopeKey;
  }
  for (const [scopeKey, bucket] of Object.entries(states)) {
    if (bucket.files.some((file) => file.id === id)) return scopeKey;
  }
  return null;
}

/** Видимые вкладки в порядке отображения плюс карта «вкладка → уровень». */
export function collectVisibleTabs(
  states: PreviewStates,
  target: PreviewTabTarget,
): {
  readonly files: ReadonlyArray<PreviewFile>;
  readonly tabScopeById: Readonly<Record<string, PreviewTabScope>>;
} {
  const files: PreviewFile[] = [];
  const tabScopeById: Record<string, PreviewTabScope> = {};
  for (const scopeKey of visibleScopeKeys(target)) {
    const bucket = states[scopeKey];
    if (!bucket) continue;
    const scope = scopeOfKey(scopeKey);
    for (const file of bucket.files) {
      files.push(file);
      tabScopeById[file.id] = scope;
    }
  }
  return { files, tabScopeById };
}

/** Закреплённые везде вкладки показаны (вне чата и в «нетронутых» чатах). */
function pinnedPanelShown(states: PreviewStates): boolean {
  const global = getPreviewBucketState(states, GLOBAL_SCOPE_KEY);
  return global.open && global.files.length > 0;
}

/**
 * Открыта ли панель в контексте — с учётом наследования: чат, где панель не
 * трогали, показывает её, только если показаны закреплённые везде вкладки.
 */
export function isPanelOpen(states: PreviewStates, target: PreviewTabTarget): boolean {
  const viewKey = viewScopeKey(target);
  const view = getPreviewBucketState(states, viewKey);
  if (viewKey !== GLOBAL_SCOPE_KEY && !view.viewTouched) return pinnedPanelShown(states);
  return view.open;
}

/** Состояние вида контекста — то, что видит человек сейчас. */
export function resolvePanelView(
  states: PreviewStates,
  target: PreviewTabTarget,
): {
  readonly view: PreviewBucketState;
  readonly open: boolean;
  readonly files: ReadonlyArray<PreviewFile>;
  readonly tabScopeById: Readonly<Record<string, PreviewTabScope>>;
  /** Панель реально на экране: открыта и есть что показать. */
  readonly visible: boolean;
} {
  const view = getPreviewBucketState(states, viewScopeKey(target));
  const open = isPanelOpen(states, target);
  const { files, tabScopeById } = collectVisibleTabs(states, target);
  return { view, open, files, tabScopeById, visible: open && files.length > 0 };
}

function patchView(
  states: PreviewStates,
  viewKey: string,
  update: (view: PreviewBucketState) => PreviewBucketState,
): PreviewStates {
  const current = getPreviewBucketState(states, viewKey);
  const next = update(current);
  return next === current ? states : { ...states, [viewKey]: next };
}

function shownView(view: PreviewBucketState, activeFileId: string | null): PreviewBucketState {
  return {
    ...view,
    open: true,
    viewTouched: true,
    dismissed: false,
    unseen: 0,
    activeFileId: activeFileId ?? view.activeFileId,
  };
}

/**
 * Показать вкладку `id` (она уже лежит в `landedKey`) в виде контекста
 * `viewKey`. Агент в панель, закрытую человеком, не врывается: вкладка станет
 * активной, когда человек откроет панель, а пока — бейдж.
 */
function revealInView(
  states: PreviewStates,
  viewKey: string,
  id: string,
  source: PanelOpenSource,
): PreviewStates {
  return patchView(states, viewKey, (view) => {
    if (source === "agent" && view.dismissed) {
      return { ...view, viewTouched: true, activeFileId: id, unseen: view.unseen + 1 };
    }
    return shownView(view, id);
  });
}

function revealTab(
  states: PreviewStates,
  target: PreviewTabTarget,
  landedKey: string,
  id: string,
  source: PanelOpenSource,
): PreviewStates {
  let next = states;
  const viewKey = viewScopeKey(target);
  // Вкладка, невидимая из вида цели (легаси-агент без треда положил её в
  // проект), вид не трогает: иначе вне чата «открылась» бы пустая панель.
  if (visibleScopeKeys(target).includes(landedKey)) {
    next = revealInView(next, viewKey, id, source);
  }
  // Закреплённая везде вкладка показывается и вне чатов.
  if (landedKey === GLOBAL_SCOPE_KEY && viewKey !== GLOBAL_SCOPE_KEY) {
    next = revealInView(next, GLOBAL_SCOPE_KEY, id, source);
  }
  return next;
}

/**
 * Положить вкладку в бакет её уровня и показать в виде цели. Уже открытая
 * вкладка (тот же id на любом видимом уровне) не дублируется.
 */
export function openTab(
  states: PreviewStates,
  target: PreviewTabTarget,
  scope: PreviewTabScope,
  file: PreviewFile,
  source: PanelOpenSource,
): PreviewStates {
  const existingKey = visibleScopeKeys(target).find((scopeKey) =>
    (states[scopeKey]?.files ?? []).some((candidate) => candidate.id === file.id),
  );
  if (existingKey) return revealTab(states, target, existingKey, file.id, source);
  const bucketKey = scopeKeyForTarget(target, scope);
  const bucket = getPreviewBucketState(states, bucketKey);
  const next = { ...states, [bucketKey]: { ...bucket, files: [...bucket.files, file] } };
  return revealTab(next, target, bucketKey, file.id, source);
}

/**
 * Браузерная вкладка с URL: уже открытая с тем же адресом на видимом уровне
 * получает фокус, иначе добавляется `makeTab()` (id выдаёт вызывающий).
 */
export function openBrowserTab(
  states: PreviewStates,
  target: PreviewTabTarget,
  scope: PreviewTabScope,
  url: string,
  makeTab: () => PreviewFile,
  source: PanelOpenSource,
): PreviewStates {
  if (url) {
    for (const scopeKey of visibleScopeKeys(target)) {
      const existing = (states[scopeKey]?.files ?? []).find(
        (file) => file.kind === "browser" && file.url === url,
      );
      if (existing) return revealTab(states, target, scopeKey, existing.id, source);
    }
  }
  return openTab(states, target, scope, makeTab(), source);
}

/** Человек открыл/закрыл панель в контексте цели. */
export function setPanelOpen(
  states: PreviewStates,
  target: PreviewTabTarget,
  open: boolean,
): PreviewStates {
  return patchView(states, viewScopeKey(target), (view) => {
    if (open) return shownView(view, null);
    if (view.viewTouched && !view.open && view.dismissed) return view;
    return { ...view, open: false, viewTouched: true, dismissed: true };
  });
}

export function togglePanelOpen(states: PreviewStates, target: PreviewTabTarget): PreviewStates {
  return setPanelOpen(states, target, !isPanelOpen(states, target));
}

/** Поменять поля вида контекста (активная вкладка, фокус, ширина…), не трогая «открыто». */
export function updatePanelView(
  states: PreviewStates,
  target: PreviewTabTarget,
  update: (view: PreviewBucketState) => PreviewBucketState,
): PreviewStates {
  return patchView(states, viewScopeKey(target), update);
}

/**
 * Перенос вкладки между уровнями (выбор человека): id сохраняется, поэтому у
 * браузерной вкладки не перезагружается страница. Закреплённая «везде»
 * вкладка сразу видна и вне чатов.
 */
export function moveTabScope(
  states: PreviewStates,
  target: PreviewTabTarget,
  id: string,
  scope: PreviewTabScope,
): PreviewStates {
  const fromKey = findTabScopeKey(states, id, visibleScopeKeys(target));
  if (!fromKey) return states;
  const toKey = scopeKeyForTarget(target, scope);
  if (fromKey === toKey) return states;
  const from = getPreviewBucketState(states, fromKey);
  const tab = from.files.find((file) => file.id === id);
  if (!tab) return states;
  let next: PreviewStates = {
    ...states,
    [fromKey]: { ...from, files: from.files.filter((file) => file.id !== id) },
  };
  const to = getPreviewBucketState(next, toKey);
  next = { ...next, [toKey]: { ...to, files: [...to.files, tab] } };
  return revealTab(next, target, toKey, id, "person");
}

/**
 * Чат закончен (Done, архив, удалён): всё, что жило в нём, — вкладки и вид
 * панели — уходит целиком (08.10, Миша: «чтобы у меня 100 чатов Done не висело
 * с открытыми вкладками»). Вкладки проекта и «везде» — не чата, их не трогаем.
 * Вернули чат из Done/архива — панель в нём начинается с чистого листа.
 *
 * `dropped` — вкладки, которых после чистки не осталось нигде (у них можно
 * освободить blob-URL и забыть прокрутку); копия того же файла в другом чате
 * живёт дальше.
 */
export function dropChatBuckets(
  states: PreviewStates,
  threadIds: ReadonlyArray<string>,
): { readonly states: PreviewStates; readonly dropped: ReadonlyArray<PreviewFile> } {
  const keys = new Set(threadIds.map(chatScopeKey));
  if (!Object.keys(states).some((key) => keys.has(key))) return { states, dropped: [] };
  const next: Record<string, PreviewBucketState> = {};
  const removed: PreviewFile[] = [];
  for (const [key, bucket] of Object.entries(states)) {
    if (keys.has(key)) removed.push(...bucket.files);
    else next[key] = bucket;
  }
  const remainingIds = new Set(
    Object.values(next).flatMap((bucket) => bucket.files.map((f) => f.id)),
  );
  const dropped = removed.filter((file) => !remainingIds.has(file.id));
  return { states: next, dropped };
}

/**
 * Закрыть вкладку (видимую копию, если она есть в нескольких бакетах) и
 * почистить вид контекста: активная вкладка, редактирование, режим исходника.
 */
export function closeTab(
  states: PreviewStates,
  target: PreviewTabTarget,
  id: string,
): { readonly states: PreviewStates; readonly closed: PreviewFile | null } {
  const scopeKey = findTabScopeKey(states, id, visibleScopeKeys(target));
  if (!scopeKey) return { states, closed: null };
  const bucket = getPreviewBucketState(states, scopeKey);
  const closed = bucket.files.find((file) => file.id === id) ?? null;
  if (!closed) return { states, closed: null };
  let next: PreviewStates = {
    ...states,
    [scopeKey]: { ...bucket, files: bucket.files.filter((file) => file.id !== id) },
  };
  const remaining = collectVisibleTabs(next, target).files;
  next = updatePanelView(next, target, (view) => ({
    ...view,
    activeFileId: view.activeFileId === id ? (remaining[0]?.id ?? null) : view.activeFileId,
    editingFileId: view.editingFileId === id ? null : view.editingFileId,
    sourceViewFileIds: view.sourceViewFileIds.filter((existing) => existing !== id),
  }));
  return { states: next, closed };
}
