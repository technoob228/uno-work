/**
 * The preset gate of the manager tools (`uno-manager`): what an assistant's
 * own token (`assistant:<projectId>`) may do under its preset — Full / Helper
 * / Observer, read off the token's scopes. Other tokens (Settings → tokens)
 * keep the plain scope rules.
 *
 * Pure: `ManagerToolService` calls it on every tool call.
 */
import type { AssistantPreset, RuntimeMode } from "@t3tools/contracts";
import {
  ASSISTANT_PRESET_COPY,
  assistantPresetAllows,
  capRuntimeToPreset,
  presetOfScopes,
  type AssistantAction,
} from "@t3tools/shared/assistantPreset";

import { assistantOfTokenLabel } from "../assistants/assistantAccess.ts";
import type { ManagerCaller } from "./Services/ManagerToolService.ts";

type Caller = Pick<ManagerCaller, "label" | "scopes" | "autoApprove">;

/** The preset of an assistant's own token; null for any other token. */
export function callerPreset(
  caller: Pick<ManagerCaller, "label" | "scopes">,
): AssistantPreset | null {
  return assistantOfTokenLabel(caller.label) === null ? null : presetOfScopes(caller.scopes);
}

const DENIED: Readonly<Record<AssistantAction, string>> = {
  "read-chats": "read chats",
  "start-chat": "start chats",
  "write-chat": "write in chats",
  "stop-chat": "stop chats",
  "answer-requests": "approve or deny what other chats ask for",
  "resolve-proposals": "approve pending actions",
  remind: "set reminders",
  "change-things": "change things",
  "create-assistant": "set up other assistants",
};

/** Why the preset refuses `action` (for the model), or null when allowed. */
export function presetDenial(caller: Pick<Caller, "label" | "scopes">, action: AssistantAction) {
  const preset = callerPreset(caller);
  if (preset === null || assistantPresetAllows(preset, action)) return null;
  const name = ASSISTANT_PRESET_COPY[preset].name;
  return `Your access is "${name}": you can't ${DENIED[action]}. ${ASSISTANT_PRESET_COPY[preset].line} Tell the person what you would do; they can change your access on your page in Uno Work. Don't retry or work around it.`;
}

/**
 * Write tools run at once (still recorded, resolved `auto:<tokenId>`). An
 * assistant token needs only `autoApprove` (Helper has no `threads:approve`
 * but its own chat starts run — the chats themselves ask the person); any
 * other token also needs `threads:approve`.
 */
export function executesAtOnce(caller: Caller): boolean {
  if (!caller.autoApprove) return false;
  return callerPreset(caller) !== null || caller.scopes.includes("threads:approve");
}

/** The runtime mode a chat this caller starts gets: the request, narrowed to the preset. */
export function createRuntimeFor(caller: Caller, requested: RuntimeMode): RuntimeMode {
  const preset = callerPreset(caller);
  return preset === null ? requested : capRuntimeToPreset(requested, preset);
}

/**
 * Helper may not steer a chat that runs freer than the chats it may start
 * (its turn would run with that chat's wider mode). Null when allowed.
 */
export function steerDenial(caller: Caller, targetRuntime: RuntimeMode): string | null {
  const preset = callerPreset(caller);
  if (preset === null || capRuntimeToPreset(targetRuntime, preset) === targetRuntime) return null;
  return `This chat runs in "${targetRuntime}" mode, freer than your access ("${ASSISTANT_PRESET_COPY[preset].name}") allows. Only the person can write in it. Start a new chat instead, or tell the person.`;
}
