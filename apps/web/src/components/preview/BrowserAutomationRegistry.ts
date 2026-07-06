import type { BrowserAutomationCommandInput } from "@t3tools/contracts";

type BrowserAutomationHandler = (input: BrowserAutomationCommandInput) => Promise<unknown>;

// Хендлер на проект: команды харнесса исполняются во вкладке своего проекта,
// даже когда пользователь смотрит другой (webview остаются смонтированными).
const handlersByProjectKey = new Map<string, BrowserAutomationHandler>();

export function setBrowserAutomationHandler(
  projectKey: string,
  handler: BrowserAutomationHandler,
): void {
  handlersByProjectKey.set(projectKey, handler);
}

/** Снимает хендлер, только если он всё ещё текущий — защита от гонки эффектов. */
export function clearBrowserAutomationHandler(
  projectKey: string,
  handler: BrowserAutomationHandler,
): void {
  if (handlersByProjectKey.get(projectKey) === handler) {
    handlersByProjectKey.delete(projectKey);
  }
}

export async function runBrowserAutomationCommandForProject(
  projectKey: string,
  input: BrowserAutomationCommandInput,
): Promise<unknown> {
  const handler = handlersByProjectKey.get(projectKey);
  if (!handler) {
    throw new Error("No embedded browser tab is open for this project.");
  }
  return handler(input);
}
