import type { BrowserAutomationCommandInput } from "@t3tools/contracts";

type BrowserAutomationHandler = (input: BrowserAutomationCommandInput) => Promise<unknown>;

// Хендлер на бакет вкладок (`previewTabScopes`): команды харнесса исполняются
// во вкладке своего уровня — чата-источника, проекта или глобальной, — даже
// когда пользователь смотрит другой чат (webview остаются смонтированными).
const handlersByScopeKey = new Map<string, BrowserAutomationHandler>();

export function setBrowserAutomationHandler(
  scopeKey: string,
  handler: BrowserAutomationHandler,
): void {
  handlersByScopeKey.set(scopeKey, handler);
}

/** Снимает хендлер, только если он всё ещё текущий — защита от гонки эффектов. */
export function clearBrowserAutomationHandler(
  scopeKey: string,
  handler: BrowserAutomationHandler,
): void {
  if (handlersByScopeKey.get(scopeKey) === handler) {
    handlersByScopeKey.delete(scopeKey);
  }
}

/**
 * Исполняет команду в первом бакете из списка, где открыта браузерная вкладка.
 * Порядок задаёт вызывающий: сначала бакет треда-источника, затем проект, затем
 * глобальные вкладки — агент правит свою вкладку, а не чужую.
 */
export async function runBrowserAutomationCommand(
  scopeKeys: ReadonlyArray<string>,
  input: BrowserAutomationCommandInput,
): Promise<unknown> {
  for (const scopeKey of scopeKeys) {
    const handler = handlersByScopeKey.get(scopeKey);
    if (handler) return handler(input);
  }
  throw new Error("No embedded browser tab is open for this chat or project.");
}

// Хендлеры, адресуемые по id вкладки. Нужны, когда команда должна попасть
// именно в конкретную вкладку, а не в «цель автоматизации» бакета: так работает
// автозаполнение сохранённого логина (`vault.fill` → `fillCredential`).
const handlersByTabId = new Map<string, BrowserAutomationHandler>();

export function setBrowserTabAutomationHandler(
  tabId: string,
  handler: BrowserAutomationHandler,
): void {
  handlersByTabId.set(tabId, handler);
}

export function clearBrowserTabAutomationHandler(
  tabId: string,
  handler: BrowserAutomationHandler,
): void {
  if (handlersByTabId.get(tabId) === handler) {
    handlersByTabId.delete(tabId);
  }
}

/** null — вкладки с таким id в этом клиенте нет (например, её закрыли). */
export function findBrowserTabAutomationHandler(tabId: string): BrowserAutomationHandler | null {
  return handlersByTabId.get(tabId) ?? null;
}
