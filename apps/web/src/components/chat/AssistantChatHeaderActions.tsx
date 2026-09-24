/**
 * The Uno chat's header: "Connect ▾" (Telegram / Slack — write there, it
 * lands with Uno; set up on the assistant settings page, which already owns
 * bot tokens, allowed chats and what each chat talks to) and the settings
 * gear (what Uno may see and do, its model, its notes). Before them: Uno's
 * engine — model and where its AI comes from (Uno gateway / your key).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, PlugIcon, SendIcon, Settings2Icon } from "lucide-react";

import type { ChannelState } from "../../assistant/assistantChat.logic";
import { useAssistantChannels } from "../../assistant/useAssistantChannels";
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

  return (
    <div className="flex shrink-0 items-center gap-1.5" data-testid="uno-header-actions">
      <AssistantModelPicker environmentId={environmentId} />
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
            <MenuItem onClick={openSettings} data-testid="uno-connect-telegram">
              <span className="grid size-4 place-items-center rounded-full bg-sky-500 text-white">
                <SendIcon className="size-2.5" />
              </span>
              <span className="flex-1">Telegram</span>
              <ChannelBadge state={channels.telegram} />
            </MenuItem>
            <MenuItem onClick={openSettings} data-testid="uno-connect-slack">
              <SlackMark className="size-4" />
              <span className="flex-1">Slack</span>
              <ChannelBadge state={channels.slack} />
            </MenuItem>
          </MenuGroup>
          <p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">
            Set up the bot and pick which chats may write — then “what each chat talks to” decides
            whether a chat lands here.
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
          Uno settings: what it sees and does, its model, Telegram
        </TooltipPopup>
      </Tooltip>
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
