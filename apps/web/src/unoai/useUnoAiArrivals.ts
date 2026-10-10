/**
 * Full app: what arrives with the page and goes to the Uno on this computer.
 *
 * - `?q=` — the console's first message (…/enter?q=, work_ai): a new chat
 *   with Uno that sends it right away;
 * - a pending hand-off from a Uno AI chat without a computer (the person
 *   pressed "Create my computer"): the whole context goes to the Uno chat
 *   (pinned) and it opens; it is forgotten only once it was sent.
 *
 * `q` is read once when this module loads — before the router may drop it on
 * a redirect (/ → /computer) — and removed from the address bar.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import type { HomeStartOptions } from "../components/computer/home/HomeComposer";
import { sendToAssistantChat } from "../assistant/sendToAssistantChat";
import { useEnvironmentSupportsAssistantChat } from "../environments/assistantChatSupport";
import { useUpdateSettings } from "../hooks/useSettings";
import { isWebLite } from "../lite/flag";
import { buildThreadRouteParams } from "../threadRoutes";
import { aiChatLive } from "./unoAiApi";
import { clearHandoff, handoffPrompt, peekHandoff, readHandoff } from "./unoAiHandoff";
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
): void {
  const { updateSettings } = useUpdateSettings();
  const uno = useUnoDefaultSelection();
  const daemonMarksChat = useEnvironmentSupportsAssistantChat(environmentId);
  const navigate = useNavigate();
  useEffect(() => {
    if (handled || environmentId === null || !uno.ready) return;
    if (arrivedQ === null && !peekHandoff()) return;
    handled = true;
    // The goal is known: don't bring the welcome picker back on the next load.
    void updateSettings({ onboardingCompleted: true, machineOnboarded: true }).catch(() => {});
    const q = arrivedQ;
    arrivedQ = null;
    const send = (prompt: string) => startTask(prompt, uno.startOptions());
    if (q) {
      void send(q);
      return;
    }
    const pending = readHandoff();
    if (!pending) return;
    void (async () => {
      try {
        const chat = await aiChatLive(pending.chatId, 0);
        if (!chat || chat.messages.length === 0) {
          clearHandoff(pending.chatId);
          return;
        }
        const prompt = handoffPrompt({
          title: chat.title ?? "",
          messages: chat.messages,
          sites: chat.sites,
        });
        // The teammate on this computer continues it in its own (pinned) chat;
        // an older daemon without one gets a new chat with Uno, as before.
        const threadId = await sendToAssistantChat({
          environmentId,
          text: prompt,
          daemonMarksChat,
        });
        if (threadId !== null) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams({ environmentId, threadId }),
          });
        } else {
          await send(prompt);
        }
        clearHandoff(pending.chatId);
      } catch {
        // Not sent: it stays remembered and goes on the next load (the chat
        // is still in Uno AI too, with "Continue on this computer").
      }
    })();
  }, [daemonMarksChat, environmentId, navigate, startTask, updateSettings, uno]);
}
