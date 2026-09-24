/**
 * Telegram / Slack of the assistant on a computer, for the Connect menu and
 * the Uno row. Read from the assistant's overview; quiet on failure (an
 * older daemon, no assistant yet) — the menu then offers to connect.
 */
import { ASSISTANT_PROJECT_ID, type EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { getAssistant } from "../lib/managerApi";
import { type ChannelState, slackChannelState, telegramChannelState } from "./assistantChat.logic";

export interface AssistantChannels {
  readonly telegram: ChannelState;
  readonly telegramBot: string | null;
  readonly slack: ChannelState;
}

const NONE: AssistantChannels = { telegram: "off", telegramBot: null, slack: "off" };

export function useAssistantChannels(
  environmentId: EnvironmentId | null,
  enabled = true,
): AssistantChannels {
  const query = useQuery({
    queryKey: ["uno-assistant", "channels", environmentId],
    queryFn: async (): Promise<AssistantChannels> => {
      const summary = await getAssistant({
        environmentId: environmentId!,
        projectId: ASSISTANT_PROJECT_ID,
      });
      return {
        telegram: telegramChannelState(summary.telegram),
        telegramBot: summary.telegram.botUsername,
        slack: slackChannelState(summary.slack),
      };
    },
    enabled: enabled && environmentId !== null,
    staleTime: 60_000,
    retry: false,
  });
  return query.data ?? NONE;
}
