/**
 * What sits under a chat shared with me instead of the usual composer
 * (SharedChatView.tsx): with "Can read" — who shared it and two ways on
 * ("Ask to write", "Continue in my own chat"); with "Can write" — a box that
 * posts to the chat, where the owner's agent gets it as my words.
 */
import { CopyPlusIcon, HandIcon, SendIcon } from "lucide-react";
import { memo, useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useChatOnComputer } from "../../hooks/useFolderChats";
import { sendPersonRequest, writeInSharedChat } from "../../team/teamApi";
import {
  teamCollabErrorMessage,
  type FeedEvent,
  type TeamPersonRef,
} from "../../team/teamApi.logic";
import { possessive, transcriptAsOutsideText } from "../../team/team.logic";
import type { SharedWithMeChat } from "../../team/teamStore";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { TeamAvatar } from "./TeamAvatar";

const nonce = () => Math.random().toString(36).slice(2, 10);

export const SharedChatReadBar = memo(function SharedChatReadBar(props: {
  readonly chat: SharedWithMeChat;
  readonly owner: TeamPersonRef | null;
  readonly ownerName: string;
  readonly computer: string;
  readonly events: ReadonlyArray<FeedEvent>;
  readonly title: string;
  readonly nameOf: (authorId: number | null) => string;
}) {
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState<"ask" | "continue" | null>(null);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { startChatOn } = useChatOnComputer();
  const name = props.ownerName;

  const askToWrite = async () => {
    if (!props.owner) return;
    setBusy("ask");
    try {
      await sendPersonRequest({
        projectId: props.chat.projectId,
        to: props.owner.userId,
        kind: "write_access",
        title: `Write in “${props.title}”`.slice(0, 120),
        text: `May I write in your chat “${props.title}”?`,
        chatId: props.chat.id,
      });
      setAsked(true);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't ask",
        description: teamCollabErrorMessage(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const continueHere = async () => {
    if (!primaryEnvironmentId) return;
    setBusy("continue");
    try {
      await startChatOn(primaryEnvironmentId, {
        prompt: transcriptAsOutsideText({
          ownerName: name,
          title: props.title,
          projectName: props.chat.projectName,
          events: props.events,
          nameOf: props.nameOf,
          nonce: nonce(),
        }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't start a chat",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-[20px] border border-border bg-muted/30 px-4 py-3"
      data-testid="shared-chat-readonly"
    >
      <TeamAvatar person={props.owner} className="size-7" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{name} shared this chat with you to read.</div>
        <div className="text-xs text-muted-foreground">
          It runs on {possessive(name)} {props.computer} and updates here as it goes. You see the
          conversation, not {possessive(name)} files.
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={asked || busy !== null || !props.owner}
          onClick={() => void askToWrite()}
          data-testid="shared-chat-ask-to-write"
        >
          <HandIcon className="size-3.5" />
          {asked ? `Asked ${name}` : "Ask to write"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || !primaryEnvironmentId}
          onClick={() => void continueHere()}
          data-testid="shared-chat-continue"
        >
          <CopyPlusIcon className="size-3.5" />
          Continue in my own chat
        </Button>
      </div>
    </div>
  );
});

export const SharedChatComposer = memo(function SharedChatComposer(props: {
  readonly chatId: number;
  readonly ownerName: string;
  readonly computer: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await writeInSharedChat(props.chatId, message);
      setText("");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Not sent",
        description: teamCollabErrorMessage(error),
      });
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid="shared-chat-composer">
      <div className="flex items-end gap-2 rounded-[20px] border border-border bg-background px-3 py-2">
        <Textarea
          unstyled
          className="flex-1"
          value={text}
          placeholder={`Write to ${possessive(props.ownerName)} agent`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button
          size="icon-sm"
          aria-label="Send"
          disabled={!text.trim() || sending}
          onClick={() => void send()}
        >
          <SendIcon className="size-3.5" />
        </Button>
      </div>
      <p className="px-3 text-[11px] text-muted-foreground">
        Goes to {possessive(props.ownerName)} agent on {props.computer}, marked as yours. Uno Work
        tools there ask {props.ownerName} first.
      </p>
    </div>
  );
});
