/**
 * "Connect Telegram" / "Connect Slack" for the assistant, opened from the
 * assistant chat's Connect ▾ menu, the Assistants screen and Settings.
 *
 * Telegram (since 05.10): a bot of the assistant's own (@BotFather,
 * `TelegramWizard`): make it, paste its token, press Start. Uno's shared bot
 * (QR, nothing to type) stays only for assistants already on it — it also
 * carries Uno's payments, course and support.
 *
 * Slack: "Add to Slack" (Uno's app) when the console has it, else the setup
 * guide for your own Slack app (manifest + two tokens).
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  type ManagerAssistantSummary,
  type ProjectId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { getAssistant } from "../../lib/managerApi";
import { AssistantSlackPanel, AssistantTelegramPanel } from "../setup/steps/ChannelsStep";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export { TelegramWizard } from "./TelegramWizard";

export type ConnectChannel = "telegram" | "slack";

/** The assistant's overview, refreshed while a connection is being made. */
export function useAssistantSummary(environmentId: EnvironmentId, fast: boolean) {
  return useQuery({
    queryKey: ["uno-assistant", "summary", environmentId],
    queryFn: (): Promise<ManagerAssistantSummary> =>
      getAssistant({ environmentId, projectId: ASSISTANT_PROJECT_ID }),
    refetchInterval: fast ? 2_500 : false,
    retry: false,
  });
}

export function ConnectChannelDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly channel: ConnectChannel | null;
  readonly onClose: () => void;
  /** Another assistant of that computer (0.0.106); its default one when absent. */
  readonly projectId?: ProjectId;
  /**
   * "own" (assistants, decision 02.10): its own bot from @BotFather first,
   * Uno's shared bot as the fallback link. Onboarding keeps the shared bot.
   */
  readonly telegramMode?: "own" | "shared";
}) {
  const projectProps = props.projectId !== undefined ? { projectId: props.projectId } : {};
  // Its own bot unless Uno's shared one was asked for (decision 05.10).
  const ownBot = props.telegramMode !== "shared";
  const open = props.channel !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogPopup
        className="max-w-lg"
        data-testid={`uno-connect-${props.channel ?? "none"}-dialog`}
      >
        <DialogHeader>
          <DialogTitle>
            {props.channel === "slack" ? "Answer in Slack" : "Answer in Telegram"}
          </DialogTitle>
          <DialogDescription>
            {props.channel === "slack"
              ? "Mention the assistant in a channel or write to it directly. Each Slack channel gets its own conversation; all of them share its memory."
              : ownBot
                ? "It gets a Telegram bot of its own: its own name and chat. You make the bot in @BotFather, then press Start."
                : "Scan the code with your phone and press Start. Write to it like to a colleague — it answers there, in the same conversation you see in Uno Work."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-4 pb-2 sm:px-6">
          {props.channel === "slack" ? (
            <AssistantSlackPanel environmentId={props.environmentId} {...projectProps} />
          ) : props.channel === "telegram" ? (
            <AssistantTelegramPanel
              environmentId={props.environmentId}
              {...projectProps}
              {...(props.telegramMode ? { initialMode: props.telegramMode } : {})}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
