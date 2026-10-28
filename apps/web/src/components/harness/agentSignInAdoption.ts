/**
 * One sign-in, everything that uses it (cap walkthrough 28.10, P2/P3): the
 * person signed Claude Code in on the start screen, then Settings → AI still
 * said "Your Claude plan — Sign in to Claude" (a second full sign-in, then
 * "Setting it up — about a minute"), and the next new chat opened on
 * "uno · Smart".
 *
 * Once a sign-in to a harness lands — in any dialog — Work:
 * - starts new chats on that agent (the "last picked" model; a fixed "New
 *   chats start on" in Settings still wins);
 * - for Claude with the person's plan (not an API key): moves the assistant
 *   (Uno) onto the same plan when it runs on Uno AI, so Settings shows it
 *   chosen and nobody signs in twice. A choice of their own (a key, ChatGPT)
 *   is left alone; if the plan can't be set up here the assistant stays on
 *   Uno AI and the person is told.
 *
 * Pure: no React, no fetch.
 */
import {
  type AssistantLlmStatus,
  type ModelSelection,
  type ProviderAuthDriver,
  type ProviderAuthMethod,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { resolveAppModelSelectionForInstance } from "../../modelSelection";

/** The model new chats start on after `driver` signed in here; null when it can't run. */
export function signedInChatSelection(input: {
  readonly driver: ProviderAuthDriver;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ModelSelection | null {
  const instanceId = ProviderInstanceId.make(input.driver);
  const model = resolveAppModelSelectionForInstance(
    instanceId,
    input.settings,
    input.providers,
    null,
  );
  return model ? { instanceId, model } : null;
}

/** How long the assistant waits for the computer to see the new Claude sign-in. */
export const CLAUDE_PLAN_WAIT_MS = 45_000;
export const CLAUDE_PLAN_POLL_MS = 3_000;

export type AssistantAdoption =
  /** Move the assistant to the Claude plan now. */
  | "switch"
  /** The computer hasn't seen the plan yet: look again shortly. */
  | "wait"
  /** Nothing to do (already on it, a choice of their own, not available here). */
  | "skip";

/**
 * What to do with the assistant after Claude Code signed in with the
 * person's account. Only Claude, only a browser sign-in (an API key is not a
 * plan), only while the assistant is on Uno AI.
 */
export function assistantAdoption(input: {
  readonly driver: ProviderAuthDriver;
  readonly method: ProviderAuthMethod;
  readonly status: AssistantLlmStatus | null;
}): AssistantAdoption {
  if (input.driver !== "claudeAgent" || input.method !== "oauth") return "skip";
  const status = input.status;
  if (!status) return "wait";
  if (status.provider !== "uno") return "skip";
  const claude = status.subscriptions?.find((entry) => entry.provider === "claude");
  // An older daemon: no plans for the assistant there.
  if (!status.subscriptions) return "skip";
  if (!claude) return "skip";
  switch (claude.state) {
    case "ready":
      return "switch";
    case "sign-in":
      // The provider probe after the sign-in hasn't landed yet.
      return "wait";
    default:
      return "skip";
  }
}
