/**
 * The header of a conversation with Uno: Uno's engine — model and where its
 * AI comes from (Uno gateway / your key) — with "Runs on Hermes" (not a
 * choice; the tooltip says why), "New conversation", "Connect ▾" (Telegram /
 * Slack: a guided dialog, see ConnectChannelDialog) and the settings gear
 * (what Uno may see and do, Telegram, Slack).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, PlugIcon, PlusIcon, SendIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { ASSISTANT_HARNESS_NOTE, type ChannelState } from "../../assistant/assistantChat.logic";
import { useAssistantChannels } from "../../assistant/useAssistantChannels";
import { useAssistantConversations } from "../../assistant/useAssistantConversations";
import { useEnvironmentSupportsAssistantLlm } from "../../environments/assistantChatSupport";
import { ConnectChannelDialog, type ConnectChannel } from "../assistant/ConnectChannelDialog";
import { AssistantModelPicker } from "./AssistantEngine";
import { cn } from "../../lib/utils";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const STATE_COPY: Record<ChannelState, { label: string; dot: string }> = {
  on: { label: "Connected", dot: "bg-success" },
  problem: { label: "Needs a look", dot: "bg-warning" },
  off: { label: "Connect", dot: "bg-muted-foreground/40" },
};

function SlackMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={props.className}>
      <path fill="#E01E5A" d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Z" />
      <path fill="#36C5F0" d="M9 6a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Z" />
      <path fill="#2EB67D" d="M18 9a2 2 0 1 1 2 2h-2V9Zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5Z" />
      <path fill="#ECB22E" d="M15 18a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z" />
    </svg>
  );
}

export function AssistantChatHeaderActions({ environmentId }: { environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const channels = useAssistantChannels(environmentId);
  const openSettings = () =>
    void navigate({
      to: "/settings/environment/$environmentId/assistants",
      params: { environmentId },
    });
  const anyOn = channels.telegram === "on" || channels.slack === "on";
  const [connecting, setConnecting] = useState<ConnectChannel | null>(null);
  const conversations = useAssistantConversations();
  const runsOnHermes = useEnvironmentSupportsAssistantLlm(environmentId);

  return (
    <div className="flex shrink-0 items-center gap-1.5" data-testid="uno-header-actions">
      <AssistantModelPicker environmentId={environmentId} />
      {runsOnHermes ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="hidden h-7 shrink-0 cursor-default items-center rounded-md px-1.5 text-[11px] text-muted-foreground @3xl/header-actions:inline-flex sm:h-6"
                data-testid="uno-runs-on-hermes"
              />
            }
          >
            Runs on Hermes
          </TooltipTrigger>
          <TooltipPopup side="bottom" className="max-w-72">
            {ASSISTANT_HARNESS_NOTE}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {conversations.supported ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="New conversation with Uno"
                onClick={() => void conversations.createConversation()}
                disabled={conversations.creating}
                data-testid="uno-new-conversation"
                className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-input px-2 text-xs font-medium text-muted-foreground shadow-xs/5 hover:bg-accent hover:text-foreground disabled:opacity-60 sm:h-6"
              />
            }
          >
            <PlusIcon className="size-3.5" />
            <span className="hidden @3xl/header-actions:inline">New conversation</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom" className="max-w-64">
            Another conversation with Uno. Same memory; Telegram and Slack keep talking to the main
            one.
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Menu>
        <MenuTrigger
          data-testid="uno-connect"
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-input px-2 text-xs font-medium shadow-xs/5 hover:bg-accent sm:h-6",
            anyOn ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {channels.telegram === "on" ? (
            <>
              <span className="grid size-3.5 place-items-center rounded-full bg-sky-500 text-white">
                <SendIcon className="size-2" />
              </span>
              Telegram
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
            </>
          ) : (
            <>
              <PlugIcon className="size-3.5" />
              Connect
            </>
          )}
          <ChevronDownIcon className="size-3 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-64">
          <MenuGroup>
            <MenuGroupLabel>Talk to Uno from</MenuGroupLabel>
            <MenuItem onClick={() => setConnecting("telegram")} data-testid="uno-connect-telegram">
              <span className="grid size-4 place-items-center rounded-full bg-sky-500 text-white">
                <SendIcon className="size-2.5" />
              </span>
              <span className="flex-1">Telegram</span>
              <ChannelBadge state={channels.telegram} />
            </MenuItem>
            <MenuItem onClick={() => setConnecting("slack")} data-testid="uno-connect-slack">
              <SlackMark className="size-4" />
              <span className="flex-1">Slack</span>
              <ChannelBadge state={channels.slack} />
            </MenuItem>
          </MenuGroup>
          <p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">
            Your Telegram chat talks to Uno's main conversation: the same Uno, the same memory.
          </p>
        </MenuPopup>
      </Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Uno settings"
              onClick={openSettings}
              data-testid="uno-settings"
              className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground shadow-xs/5 hover:bg-accent hover:text-foreground sm:h-6 sm:min-w-6"
            />
          }
        >
          <Settings2Icon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          Uno settings: what it can see and manage, Telegram, Slack
        </TooltipPopup>
      </Tooltip>
      <ConnectChannelDialog
        environmentId={environmentId}
        channel={connecting}
        onClose={() => setConnecting(null)}
      />
    </div>
  );
}

function ChannelBadge({ state }: { state: ChannelState }) {
  const copy = STATE_COPY[state];
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", copy.dot)} aria-hidden />
      {copy.label}
    </span>
  );
}
