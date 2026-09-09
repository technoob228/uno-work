/**
 * Долгоживущие вкладки правой панели.
 *
 * Уровни `global` и `project` — это осознанный выбор пользователя «пусть будет
 * открыто», поэтому такие вкладки переживают перезагрузку клиента. Вкладки
 * уровня `chat` эфемерны и НЕ сохраняются: иначе localStorage копил бы бакет на
 * каждый когда-либо открытый тред.
 *
 * Сохраняются только браузерные вкладки: у них состояние — это URL. Файлы и
 * панели плагинов зависят от живого окружения (`environmentId`), которого после
 * перезапуска может уже не быть, и восстановленная вкладка показывала бы ошибку
 * чтения вместо содержимого.
 */

import { GLOBAL_SCOPE_KEY, scopeOfKey } from "./previewTabScopes";
// Только тип: значение из PreviewPaneContext здесь импортировать нельзя —
// контекст сам импортирует этот модуль, и вышел бы цикл на уровне значений.
import type { PreviewFile } from "./PreviewPaneContext";

const STORAGE_KEY = "uno_preview_tabs_v1";
const MAX_TABS_PER_BUCKET = 20;
const MAX_BUCKETS = 40;

interface PersistedTab {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface PersistedTabBuckets {
  readonly [scopeKey: string]: ReadonlyArray<PersistedTab>;
}

function isPersistedTab(value: unknown): value is PersistedTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    typeof tab.name === "string" &&
    typeof tab.url === "string" &&
    tab.url.length > 0
  );
}

/** Что достойно сохранения: непустые браузерные вкладки долгих уровней. */
export function collectPersistableTabs(
  states: Readonly<Record<string, { readonly files: ReadonlyArray<PreviewFile> }>>,
): PersistedTabBuckets {
  const buckets: Record<string, ReadonlyArray<PersistedTab>> = {};
  for (const [scopeKey, bucket] of Object.entries(states)) {
    if (scopeOfKey(scopeKey) === "chat") continue;
    const tabs = bucket.files
      .filter((file) => file.kind === "browser" && (file.url ?? "").length > 0)
      .slice(0, MAX_TABS_PER_BUCKET)
      .map((file) => ({ id: file.id, name: file.name, url: file.url! }));
    if (tabs.length > 0) buckets[scopeKey] = tabs;
  }
  return buckets;
}

/** Обратно в бакеты предпросмотра: браузерные вкладки без содержимого. */
export function restoreTabs(buckets: PersistedTabBuckets): Record<string, PreviewFile[]> {
  const restored: Record<string, PreviewFile[]> = {};
  for (const [scopeKey, tabs] of Object.entries(buckets)) {
    restored[scopeKey] = tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      kind: "browser" as const,
      content: "",
      url: tab.url,
    }));
  }
  return restored;
}

export function readPersistedTabs(): PersistedTabBuckets {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const buckets: Record<string, ReadonlyArray<PersistedTab>> = {};
    for (const [scopeKey, value] of Object.entries(parsed as Record<string, unknown>).slice(
      0,
      MAX_BUCKETS,
    )) {
      if (!Array.isArray(value)) continue;
      // Глобальный бакет и проектные — да, чат-бакеты из старых версий игнорим.
      if (scopeKey !== GLOBAL_SCOPE_KEY && scopeOfKey(scopeKey) === "chat") continue;
      const tabs = value.filter(isPersistedTab).slice(0, MAX_TABS_PER_BUCKET);
      if (tabs.length > 0) buckets[scopeKey] = tabs;
    }
    return buckets;
  } catch {
    return {};
  }
}

export function writePersistedTabs(buckets: PersistedTabBuckets): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(buckets).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(buckets));
  } catch {
    // Приватный режим/переполненный storage — вкладки просто не переживут перезагрузку.
  }
}
