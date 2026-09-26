/**
 * The assistant on Home, said plainly (meeting feedback 25.09: "Hermes is
 * already there, but nobody sees it"): "Your assistant is already working —
 * write to it in Telegram", with the one button that gets you there.
 * Uno stays reachable here when it is hidden from the sidebar.
 */
import { useNavigate } from "@tanstack/react-router";
import { MessageCircleIcon, PlusIcon, SendIcon } from "lucide-react";

import { useAssistantChannels } from "../../../assistant/useAssistantChannels";
import { useAssistantChat } from "../../../assistant/useAssistantChat";
import { useAssistantConversations } from "../../../assistant/useAssistantConversations";
import { openInstallDocs } from "../../onboarding/harnessInstallLinks";
import { Button } from "../../ui/button";

export function HomeUnoEntry() {
  const { environmentId, open, opening } = useAssistantChat();
  const conversations = useAssistantConversations();
  const channels = useAssistantChannels(environmentId);
  const navigate = useNavigate();
  if (environmentId === null) return null;
  const telegramOn = channels.telegram === "on";
  const bot = channels.telegramBot;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/70 px-3 py-2.5"
      data-testid="home-uno"
    >
      <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        U
        <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background bg-success" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-foreground">
          Your assistant is already working
        </span>
        <span className="text-xs text-muted-foreground">
          {telegramOn
            ? `Write to it in Telegram${bot ? ` @${bot}` : ""}. It answers day and night.`
            : "Write to it in Telegram. It answers day and night, even when your laptop is closed."}
        </span>
      </span>
      {telegramOn ? (
        <Button
          size="sm"
          onClick={() => openInstallDocs(bot ? `https://t.me/${bot}` : "https://t.me")}
          data-testid="home-uno-telegram"
        >
          <SendIcon className="size-3.5" />
          Open Telegram
        </Button>
      ) : (
        <Button
          size="sm"
          onClick={() =>
            void navigate({
              to: "/setup",
              search: { step: "welcome", goal: "assistant", via: "uno_ai" },
            })
          }
          data-testid="home-uno-telegram"
        >
          <SendIcon className="size-3.5" />
          Write in Telegram
        </Button>
      )}
      <button
        type="button"
        onClick={() => void open()}
        disabled={opening}
        className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-primary hover:bg-accent disabled:opacity-60"
        data-testid="home-uno-open"
      >
        <MessageCircleIcon className="size-3" />
        Talk here
      </button>
      {conversations.supported ? (
        <button
          type="button"
          onClick={() => void conversations.createConversation()}
          disabled={conversations.creating}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          <PlusIcon className="size-3" />
          New conversation
        </button>
      ) : null}
    </div>
  );
}
