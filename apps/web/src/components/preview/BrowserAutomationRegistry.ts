import type { BrowserAutomationCommandInput } from "@t3tools/contracts";

type BrowserAutomationHandler = (input: BrowserAutomationCommandInput) => Promise<unknown>;

let activeBrowserAutomationHandler: BrowserAutomationHandler | null = null;

export function setActiveBrowserAutomationHandler(handler: BrowserAutomationHandler | null): void {
  activeBrowserAutomationHandler = handler;
}

export async function runActiveBrowserAutomationCommand(
  input: BrowserAutomationCommandInput,
): Promise<unknown> {
  if (!activeBrowserAutomationHandler) {
    throw new Error("No active embedded browser tab.");
  }
  return activeBrowserAutomationHandler(input);
}
