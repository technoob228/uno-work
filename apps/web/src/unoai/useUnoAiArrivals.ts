/**
 * Full app: what arrives with the page and goes to the Uno on this computer.
 *
 * - `?q=` — the console's first message (…/enter?q=, work_ai): a new chat
 *   with Uno that sends it right away;
 * - a pending hand-off from a Uno AI chat without a computer (the person
 *   pressed "Create my computer"): a new chat with the whole context.
 *
 * `q` is read once when this module loads — before the router may drop it on
 * a redirect (/ → /computer) — and removed from the address bar.
 */
import { DEFAULT_RUNTIME_MODE, ProviderInstanceId, type EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useAccountDefaultAiState } from "../assistant/useAccountDefaultAi";
import {
  agentDriverFromAccountDefault,
  briefStartFor,
} from "../components/computer/home/agentStart";
import type { HomeStartOptions } from "../components/computer/home/HomeComposer";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import { useServerProviders } from "../rpc/serverState";
import { isWebLite } from "../lite/flag";
import { aiChatLive } from "./unoAiApi";
import { handoffPrompt, peekHandoff, takeHandoff } from "./unoAiHandoff";
import { useUnoDefaultSelection } from "./useUnoDefaultSelection";

let arrivedQ: string | null = null;
if (!isWebLite && typeof window !== "undefined") {
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get("q")?.trim();
    if (q) {
      arrivedQ = q.slice(0, 2000);
      url.searchParams.delete("q");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  } catch {
    // no URL API: nothing arrived
  }
}

let handled = false;

/**
 * Something arrived for Uno (a first message, a hand-off): the person already
 * said what they want — the welcome "What do you want to do?" is skipped and
 * Home opens with the chat (routes/__root.tsx).
 */
export function hasUnoAiArrival(): boolean {
  return !isWebLite && (arrivedQ !== null || peekHandoff());
}

export function useUnoAiArrivals(
  environmentId: EnvironmentId | null,
  startTask: (prompt: string, options: HomeStartOptions) => Promise<void>,
  /** The same chat with the prompt typed, not sent. */
  typeTask?: (prompt: string, options: HomeStartOptions) => Promise<void>,
): void {
  const { updateSettings } = useUpdateSettings();
  const uno = useUnoDefaultSelection();
  // "Do you already use Claude or ChatGPT? — Yes" in the console (default_ai):
  // the console's first message goes to that agent, not to Uno AI (walk 16.10).
  const account = useAccountDefaultAiState(!isWebLite && arrivedQ !== null);
  const providers = useServerProviders();
  const settings = useSettings();
  useEffect(() => {
    if (handled || environmentId === null || !uno.ready || !account.ready) return;
    if (arrivedQ === null && !peekHandoff()) return;
    handled = true;
    // The goal is known: don't bring the welcome picker back on the next load.
    void updateSettings({ onboardingCompleted: true, machineOnboarded: true }).catch(() => {});
    const q = arrivedQ;
    arrivedQ = null;
    const send = (prompt: string) => startTask(prompt, uno.startOptions());
    if (q) {
      const agent = agentDriverFromAccountDefault(account.value);
      const how = briefStartFor({ accountDefault: agent, providers });
      const instanceId = agent ? ProviderInstanceId.make(agent) : null;
      const model =
        how && instanceId
          ? resolveAppModelSelectionForInstance(instanceId, settings, providers, null)
          : null;
      if (instanceId && model) {
        const options: HomeStartOptions = {
          folder: null,
          modelSelection: { instanceId, model },
          runtimeMode: DEFAULT_RUNTIME_MODE,
        };
        // Signed in with their own account: it starts now. Not yet: the brief
        // waits typed in a chat on that agent, and its sign-in opens
        // (HomeAgentSignIn) — never a turn on a logged-out CLI or on Uno AI.
        if (how === "send") {
          void startTask(q, options);
          return;
        }
        if (typeTask) {
          void typeTask(q, options);
          return;
        }
      }
      void send(q);
      return;
    }
    const pending = takeHandoff();
    if (!pending) return;
    void (async () => {
      try {
        const chat = await aiChatLive(pending.chatId, 0);
        if (!chat || chat.messages.length === 0) return;
        await send(
          handoffPrompt({ title: chat.title ?? "", messages: chat.messages, sites: chat.sites }),
        );
      } catch {
        // the chat is still in Uno AI; "Continue on this computer" there
      }
    })();
  }, [account, environmentId, providers, settings, startTask, typeTask, updateSettings, uno]);
}
