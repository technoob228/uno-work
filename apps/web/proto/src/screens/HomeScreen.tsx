/**
 * Home as in 0.0.81 (variant A: composer + Continue), trimmed. In C3 it is
 * also the Inbox: "Needs you" cards on top with the action in place, then
 * Continue = chats + app notifications (0.0.82), then a fold for Earlier.
 */
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, HouseIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { type InboxItem } from "../data";
import { AppGlyph, InboxKindIcon, PageHeader, ProjectGlyph, STATUS_DOT, ago, appName } from "../parts/bits";
import { ItemActions, useOpenItem } from "../parts/InboxList";
import { visibleThread } from "../shell/Sidebar";
import { useProject, useProto } from "../store";

export function HomeScreen() {
  const inboxVariant = useProto((s) => s.inboxVariant);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={<HouseIcon />} title="Home" right={<span className="text-xs text-muted-foreground">misha-work · On</span>} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-7 px-6 py-10">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Good evening, Misha</h1>
            <p className="text-sm text-muted-foreground">What should we work on?</p>
          </div>
          <HomeComposer />
          {inboxVariant === "c3" ? <MergedInbox /> : <ContinueChats />}
        </div>
      </div>
    </div>
  );
}

function HomeComposer() {
  const newChat = useProto((s) => s.newChat);
  const [text, setText] = useState("");
  const home = useProject("home");
  return (
    <div className="rounded-2xl border bg-card p-2.5 shadow-xs">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && text.trim()) {
            e.preventDefault();
            newChat("home", text.trim());
          }
        }}
        rows={2}
        placeholder="Ask anything, or describe an app to build…"
        className="w-full resize-none bg-transparent px-2 py-1 text-sm outline-none"
      />
      <div className="flex items-center gap-2 px-1">
        <span className="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-0.5 text-xs">
          <ProjectGlyph project={home} className="size-4 text-[8px]" /> Home folder <ChevronDownIcon className="size-3 text-muted-foreground" />
        </span>
        <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">Uno AI · Sonnet</span>
        <button
          type="button"
          onClick={() => text.trim() && newChat("home", text.trim())}
          className="ml-auto grid size-7 place-items-center rounded-full bg-primary text-primary-foreground"
        >
          <ArrowUpIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function ContinueChats() {
  const threads = useProto((s) => s.threads);
  const assistantVariant = useProto((s) => s.assistantVariant);
  const go = useProto((s) => s.go);
  const list = threads.filter((t) => !t.draft && !t.assistant && visibleThread(t, assistantVariant)).slice(0, 4);
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold">Continue</h2>
      <div className="grid grid-cols-2 gap-2.5">
        {list.map((t) => (
          <button key={t.id} type="button" onClick={() => go({ kind: "chat", threadId: t.id })} className="flex flex-col gap-1 rounded-xl border bg-card p-3 text-left hover:bg-accent/60">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={cn("size-1.5 rounded-full", STATUS_DOT[t.status])} />
              {t.status === "approval" || t.status === "input" ? "Needs you" : t.status === "working" ? "Working" : ago(t.updatedMin)}
            </span>
            <span className="truncate text-sm font-medium">{t.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** C3: Needs you + Continue (chats and apps) + Earlier, with Done on every card. */
function MergedInbox() {
  const inbox = useProto((s) => s.inbox);
  const needs = inbox.filter((i) => (i.kind === "approval" || i.kind === "input") && !i.read);
  const cont = inbox.filter((i) => !needs.includes(i) && i.minAgo < 60 * 12 && !i.read);
  const earlier = inbox.filter((i) => !needs.includes(i) && !cont.includes(i));
  const [showEarlier, setShowEarlier] = useState(false);
  return (
    <>
      {needs.length > 0 ? (
        <section className="flex flex-col gap-2.5">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            Needs you <span className="rounded-full bg-warning px-1.5 text-[10px] text-warning-foreground">{needs.length}</span>
          </h2>
          <div className="flex flex-col gap-2">
            {needs.map((i) => (
              <Card key={i.id} item={i} wide />
            ))}
          </div>
        </section>
      ) : null}
      <section className="flex flex-col gap-2.5">
        <h2 className="text-sm font-semibold">Continue</h2>
        <div className="grid grid-cols-2 gap-2.5">
          {cont.map((i) => (
            <Card key={i.id} item={i} />
          ))}
        </div>
        <button type="button" onClick={() => setShowEarlier(!showEarlier)} className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground">
          <ChevronDownIcon className={cn("size-3.5 transition-transform", !showEarlier && "-rotate-90")} /> Earlier ({earlier.length})
        </button>
        {showEarlier ? (
          <div className="grid grid-cols-2 gap-2.5 opacity-80">
            {earlier.map((i) => (
              <Card key={i.id} item={i} />
            ))}
          </div>
        ) : null}
      </section>
    </>
  );
}

function Card({ item, wide }: { item: InboxItem; wide?: boolean }) {
  const open = useOpenItem();
  const dismiss = useProto((s) => s.dismiss);
  return (
    <div
      onClick={() => open(item)}
      className={cn(
        "group relative flex cursor-pointer gap-2.5 rounded-xl border bg-card p-3 hover:bg-accent/40",
        wide && (item.kind === "approval" ? "border-amber-500/40" : "border-indigo-500/40"),
      )}
    >
      {item.kind === "app" && item.appId ? <AppGlyph appId={item.appId} /> : <InboxKindIcon item={item} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {item.appId ? appName(item.appId) : item.kind === "done" ? "Finished" : item.kind === "failed" ? "Failed" : "Chat"} · {ago(item.minAgo)}
        </div>
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="truncate text-xs text-muted-foreground">{item.detail}</div>
        {wide ? (
          <div className="mt-2">
            <ItemActions item={item} stop />
          </div>
        ) : null}
      </div>
      {!wide ? (
        <button
          type="button"
          title="Done"
          onClick={(e) => {
            e.stopPropagation();
            dismiss(item.id);
          }}
          className="absolute top-2 right-2 hidden items-center gap-1 rounded-md bg-popover px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-border group-hover:flex hover:text-foreground"
        >
          <CheckIcon className="size-3" /> Done
        </button>
      ) : (
        <button type="button" aria-label="Dismiss" onClick={(e) => e.stopPropagation()} className="self-start text-muted-foreground/50 hover:text-foreground">
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
