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
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { isWebLite } from "../lite/flag";
import { aiChatLive } from "./unoAiApi";
import { handoffPrompt, takeHandoff } from "./unoAiHandoff";

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

export function useUnoAiArrivals(
  environmentId: EnvironmentId | null,
  sendToUno: (prompt: string) => Promise<void>,
): void {
  useEffect(() => {
    if (handled || environmentId === null) return;
    handled = true;
    const q = arrivedQ;
    arrivedQ = null;
    if (q) {
      void sendToUno(q);
      return;
    }
    const pending = takeHandoff();
    if (!pending) return;
    void (async () => {
      try {
        const chat = await aiChatLive(pending.chatId, 0);
        if (!chat || chat.messages.length === 0) return;
        await sendToUno(
          handoffPrompt({ title: chat.title ?? "", messages: chat.messages, sites: chat.sites }),
        );
      } catch {
        // the chat is still in Uno AI; "Continue on this computer" there
      }
    })();
  }, [environmentId, sendToUno]);
}
