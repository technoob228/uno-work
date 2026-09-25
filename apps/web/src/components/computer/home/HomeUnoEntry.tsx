/**
 * Uno on Home (0.0.85): one quiet line under the composer — open the main
 * conversation or start another. Uno stays reachable here when it is hidden
 * from the sidebar (Settings → Assistant → Show in sidebar).
 */
import { PlusIcon, SendIcon } from "lucide-react";

import { ASSISTANT_VALUE_LINE } from "../../../assistant/assistantChat.logic";
import { useAssistantChannels } from "../../../assistant/useAssistantChannels";
import { useAssistantChat } from "../../../assistant/useAssistantChat";
import { useAssistantConversations } from "../../../assistant/useAssistantConversations";

export function HomeUnoEntry() {
  const { environmentId, open, opening } = useAssistantChat();
  const conversations = useAssistantConversations();
  const channels = useAssistantChannels(environmentId);
  if (environmentId === null) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border/70 px-3 py-2"
      data-testid="home-uno"
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
        U
      </span>
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Uno</span> · {ASSISTANT_VALUE_LINE}
      </span>
      {channels.telegram === "on" ? (
        <SendIcon className="size-3.5 text-sky-500" aria-label="Connected to Telegram" />
      ) : null}
      <button
        type="button"
        onClick={() => void open()}
        disabled={opening}
        className="rounded-full px-2 py-1 text-xs font-medium text-primary hover:bg-accent disabled:opacity-60"
        data-testid="home-uno-open"
      >
        Talk to Uno
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
