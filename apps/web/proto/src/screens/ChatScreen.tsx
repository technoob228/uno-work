/**
 * A chat: header (title, the folder chip, variant controls), messages
 * (including "Started chat …" cards and messages that came from Telegram),
 * an approval or a question waiting at the bottom, and the composer.
 */
import {
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  CornerDownRightIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PinIcon,
  ShieldQuestionIcon,
  TerminalIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { ASSISTANT_ID, type Message, type Thread } from "../data";
import { AssistantHeaderControls } from "../parts/Assistant";
import { STATUS_DOT, TelegramGlyph, PageHeader, SlackGlyph } from "../parts/bits";
import { FolderChip } from "../parts/FolderChip";
import { useProject, useProto } from "../store";

export function ChatScreen({ threadId }: { threadId: string }) {
  const thread = useProto((s) => s.threads.find((t) => t.id === threadId));
  const variant = useProto((s) => s.assistantVariant);
  const telegramLinked = useProto((s) => s.telegramLinked);
  const scroller = useRef<HTMLDivElement>(null);
  const count = thread?.messages.length ?? 0;
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [count]);
  if (!thread) return null;
  const isAssistant = (variant === "b1" && thread.id === ASSISTANT_ID) || (variant === "b2" && thread.assistant);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={isAssistant ? <BotIcon className="text-primary" /> : <MessageSquareIcon />}
        title={thread.title}
        right={
          <>
            {isAssistant ? <AssistantHeaderControls thread={thread} /> : null}
            {variant === "b3" && telegramLinked && !thread.draft ? (
              <span className="flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs text-muted-foreground" title="Reply to its notifications in Telegram to continue here">
                <TelegramGlyph /> Replies from Telegram land here
              </span>
            ) : null}
            <ChatMenu thread={thread} />
          </>
        }
      >
        <FolderChip thread={thread} />
        {isAssistant ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-primary">Always on</span>
        ) : null}
        {thread.spawnedBy && variant !== "b3" ? <SpawnedBy /> : null}
      </PageHeader>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          {thread.draft && thread.messages.length === 0 ? <DraftEmpty projectId={thread.projectId} /> : null}
          {isAssistant ? (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="h-px flex-1 bg-border" /> Today <span className="h-px flex-1 bg-border" />
            </div>
          ) : null}
          {thread.messages.map((msg) => (
            <MessageView key={msg.id} msg={msg} />
          ))}
          {thread.status === "working" ? (
            <div className="flex items-center gap-2 text-xs text-sky-600">
              <span className="size-1.5 animate-pulse rounded-full bg-sky-500" /> Working…
            </div>
          ) : null}
          {thread.approval ? <ApprovalCard thread={thread} /> : null}
          {thread.question ? <QuestionCard thread={thread} /> : null}
        </div>
      </div>
      <Composer thread={thread} isAssistant={Boolean(isAssistant)} />
    </div>
  );
}

function SpawnedBy() {
  const go = useProto((s) => s.go);
  return (
    <button
      type="button"
      onClick={() => go({ kind: "chat", threadId: ASSISTANT_ID })}
      className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-primary hover:bg-primary/15"
    >
      <CornerDownRightIcon className="size-3" /> from Uno
    </button>
  );
}

function ChatMenu({ thread }: { thread: Thread }) {
  const variant = useProto((s) => s.assistantVariant);
  const setAssistant = useProto((s) => s.setAssistant);
  const toast = useProto((s) => s.toast);
  return (
    <Menu>
      <MenuTrigger
        render={
          <button type="button" aria-label="Chat menu" className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            <EllipsisIcon className="size-4" />
          </button>
        }
      />
      <MenuPopup align="end" className="min-w-60">
        <MenuItem onClick={() => toast("Pinned")}>
          <PinIcon /> Pin
        </MenuItem>
        <MenuItem onClick={() => toast("Terminal is not part of this prototype")}>
          <TerminalIcon /> Open terminal here
        </MenuItem>
        {variant === "b2" ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => setAssistant(thread.id, !thread.assistant)}>
              <BotIcon />
              <span className="flex flex-col">
                <span>{thread.assistant ? "Stop being an assistant" : "Make this an assistant"}</span>
                <span className="text-[11px] text-muted-foreground">
                  {thread.assistant ? "Unpins it and disconnects Telegram/Slack" : "Always on, pinned, reachable from Telegram/Slack"}
                </span>
              </span>
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function DraftEmpty({ projectId }: { projectId: string }) {
  const variant = useProto((s) => s.newVariant);
  const project = useProject(projectId);
  return (
    <div className="mt-16 flex flex-col items-center gap-2 text-center">
      <div className="text-lg font-semibold">What should we do?</div>
      <p className="max-w-md text-sm text-muted-foreground">
        This chat works in <b>{project.id === "home" ? "your Home folder" : project.path}</b>. To work in another folder, click the chip next to the title
        {variant === "a2" ? " — any folder you pick becomes a project by itself." : "."}
      </p>
    </div>
  );
}

function MessageView({ msg }: { msg: Message }) {
  const go = useProto((s) => s.go);
  const target = useProto((s) => (msg.ref ? s.threads.find((t) => t.id === msg.ref) : undefined));
  if (msg.role === "user" || msg.role === "external") {
    return (
      <div className="flex flex-col items-end gap-1">
        {msg.via ? (
          <span className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
            {msg.via === "telegram" ? <TelegramGlyph className="size-3" /> : <SlackGlyph className="size-3" />} via {msg.via === "telegram" ? "Telegram" : "Slack"}
          </span>
        ) : null}
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-sm">{msg.text}</div>
      </div>
    );
  }
  if (msg.role === "tool") {
    return (
      <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <TerminalIcon className="size-3.5" /> {msg.text}
      </div>
    );
  }
  if (msg.role === "spawn") {
    return (
      <button
        type="button"
        onClick={() => msg.ref && go({ kind: "chat", threadId: msg.ref })}
        className="flex w-fit items-center gap-2.5 rounded-xl border bg-card px-3 py-2 text-left text-sm shadow-xs hover:bg-accent"
      >
        <CornerDownRightIcon className="size-4 text-primary" />
        <span>
          <span className="block text-[11px] text-muted-foreground">Started chat</span>
          <span className="font-medium">{msg.text}</span>
        </span>
        {target ? (
          <span className="ml-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn("size-1.5 rounded-full", STATUS_DOT[target.status])} />
            {target.status === "approval" ? "needs approval" : target.status}
          </span>
        ) : null}
      </button>
    );
  }
  return <div className="max-w-[85%] text-sm leading-relaxed">{msg.text}</div>;
}

function ApprovalCard({ thread }: { thread: Thread }) {
  const approve = useProto((s) => s.approve);
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldQuestionIcon className="size-4 text-amber-600" /> Wants to run a command
      </div>
      <code className="mt-2 block rounded-md bg-background px-2 py-1.5 text-xs">{thread.approval!.command}</code>
      <p className="mt-1.5 text-xs text-muted-foreground">{thread.approval!.why}</p>
      <div className="mt-2.5 flex gap-2">
        <Button size="xs" onClick={() => approve(thread.id)}>
          <CheckIcon /> Approve
        </Button>
        <Button size="xs" variant="outline">
          Deny
        </Button>
      </div>
    </div>
  );
}

function QuestionCard({ thread }: { thread: Thread }) {
  const answer = useProto((s) => s.answer);
  return (
    <div className="rounded-xl border border-indigo-500/40 bg-indigo-500/5 p-3">
      <div className="text-sm font-medium">{thread.question!.text}</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {thread.question!.options.map((o) => (
          <Button key={o} size="xs" variant="outline" onClick={() => answer(thread.id, o)}>
            {o}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Composer({ thread, isAssistant }: { thread: Thread; isAssistant: boolean }) {
  const sendDraft = useProto((s) => s.sendDraft);
  const askAssistant = useProto((s) => s.askAssistant);
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    if (isAssistant) askAssistant(text.trim());
    else sendDraft(thread.id, text.trim());
    setText("");
  };
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-5">
      <div className="rounded-2xl border bg-card p-2 shadow-xs">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={isAssistant ? "Ask Uno anything — it can start chats for you…" : "Message…"}
          className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none"
        />
        <div className="flex items-center gap-2 px-1">
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">Uno AI · Sonnet</span>
          {isAssistant ? <span className="text-[11px] text-muted-foreground">Also answers in Telegram</span> : null}
          <button type="button" onClick={send} className="ml-auto grid size-7 place-items-center rounded-full bg-primary text-primary-foreground">
            <ArrowUpIcon className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
