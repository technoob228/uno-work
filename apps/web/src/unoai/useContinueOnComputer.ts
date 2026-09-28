/**
 * Full app only: move a Uno AI chat (no computer) to the Uno on the connected
 * computer — a new chat there whose first message carries the whole context
 * (unoAiHandoff.ts), sent at once.
 */
import { useCallback } from "react";

import { useHomeLaunchers } from "../components/computer/useHomeLaunchers";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useStore } from "../store";
import { aiChatLive } from "./unoAiApi";
import { handoffPrompt } from "./unoAiHandoff";
import { useUnoDefaultSelection } from "./useUnoDefaultSelection";

export function useContinueOnComputer() {
  const primary = usePrimaryEnvironmentId();
  const active = useStore((state) => state.activeEnvironmentId);
  const environmentId = active ?? primary;
  const launchers = useHomeLaunchers(environmentId);
  const uno = useUnoDefaultSelection();

  const run = useCallback(
    async (chatId: string) => {
      const chat = await aiChatLive(chatId, 0);
      if (!chat || chat.messages.length === 0) throw new Error("This chat is empty.");
      const prompt = handoffPrompt({
        title: chat.title ?? "",
        messages: chat.messages,
        sites: chat.sites,
      });
      await launchers.startTask(prompt, uno.startOptions());
    },
    [launchers, uno],
  );

  return { available: environmentId !== null, run };
}
