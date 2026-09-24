/**
 * B1 / B2: the assistant's header controls — Telegram and Slack pills with
 * a click-only connect flow (our shared bot + a deep link, no BotFather
 * token), and the settings sheet: what it can see, may it act on its own,
 * may it start chats, model, instructions.
 */
import { CheckIcon, QrCodeIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import type { Thread } from "../data";
import { useProto } from "../store";
import { ProjectGlyph, SlackGlyph, TelegramGlyph } from "./bits";

export function ConnectorPill({ thread, kind }: { thread: Thread; kind: "telegram" | "slack" }) {
  const setConnector = useProto((s) => s.setConnector);
  const on = (thread.connectors ?? []).includes(kind);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<0 | 1>(0);
  const name = kind === "telegram" ? "Telegram" : "Slack";
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setStep(0);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
              on ? "border-emerald-500/30 bg-emerald-500/8 text-foreground" : "border-dashed text-muted-foreground hover:text-foreground",
            )}
          >
            {kind === "telegram" ? <TelegramGlyph /> : <SlackGlyph />}
            {on ? name : `Connect ${name}`}
            {on ? <span className="size-1.5 rounded-full bg-success" /> : null}
          </button>
        }
      />
      <PopoverPopup align="end" sideOffset={6} className="w-80 [&>div]:p-3">
        {on ? (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2 font-medium">
              {kind === "telegram" ? <TelegramGlyph className="size-4" /> : <SlackGlyph className="size-4" />}
              {kind === "telegram" ? "@UnoWorkBot · Mikhail T." : "uno4 workspace · #general"}
            </div>
            <p className="text-xs text-muted-foreground">
              {kind === "telegram"
                ? "Messages to the bot land in this chat. Replies, finished work and approvals go back to Telegram."
                : "Mention @Uno in a channel or DM it — it lands in this chat and replies in the thread."}
            </p>
            <div className="flex items-center justify-between rounded-lg bg-muted/60 px-2.5 py-2 text-xs">
              Send approvals to {name}
              <Switch defaultChecked />
            </div>
            <Button
              size="xs"
              variant="destructive-outline"
              className="self-start"
              onClick={() => {
                setConnector(thread.id, kind, false);
                setOpen(false);
              }}
            >
              Disconnect
            </Button>
          </div>
        ) : step === 0 ? (
          <div className="flex flex-col gap-2.5 text-sm">
            <div className="font-medium">Talk to {thread.title} from {name}</div>
            {kind === "telegram" ? (
              <>
                <div className="flex gap-3">
                  <div className="grid size-24 shrink-0 place-items-center rounded-lg border bg-white text-zinc-800">
                    <QrCodeIcon className="size-16" />
                  </div>
                  <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                    <li>Scan with your phone or press Open Telegram.</li>
                    <li>Press Start in the bot.</li>
                    <li>That's it — this chat is now in your Telegram.</li>
                  </ol>
                </div>
                <Button size="sm" onClick={() => setStep(1)}>
                  <TelegramGlyph /> Open Telegram
                </Button>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">Add the Uno app to your Slack workspace. You'll pick the channels it can read.</p>
                <Button size="sm" onClick={() => setStep(1)}>
                  <SlackGlyph /> Add to Slack
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5 text-sm">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              Waiting for {kind === "telegram" ? "Start in Telegram" : "Slack to confirm"}…
            </div>
            <Button
              size="sm"
              onClick={() => {
                setConnector(thread.id, kind, true);
                setOpen(false);
                setStep(0);
              }}
            >
              <CheckIcon /> (prototype) Pretend I pressed it
            </Button>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}

export function AssistantHeaderControls({ thread }: { thread: Thread }) {
  const openSheet = useProto((s) => s.openAssistantSheet);
  return (
    <>
      <ConnectorPill thread={thread} kind="telegram" />
      <ConnectorPill thread={thread} kind="slack" />
      <button
        type="button"
        aria-label="Assistant settings"
        onClick={() => openSheet(thread.id)}
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <SettingsIcon className="size-4" />
      </button>
    </>
  );
}

export function AssistantSheet() {
  const id = useProto((s) => s.assistantSheet);
  const close = useProto((s) => s.openAssistantSheet);
  const thread = useProto((s) => s.threads.find((t) => t.id === id));
  const projects = useProto((s) => s.projects);
  const variant = useProto((s) => s.assistantVariant);
  const setAssistant = useProto((s) => s.setAssistant);
  const [scope, setScope] = useState<"all" | "some">("all");
  return (
    <Dialog open={Boolean(id)} onOpenChange={(o) => (o ? null : close(null))}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{thread?.title ?? "Uno"} · assistant</DialogTitle>
          <DialogDescription>
            An always-on chat. You can write to it here, in Telegram or in Slack — it's the same conversation. It can start and watch other chats for you.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 text-sm">
          <section className="flex flex-col gap-2">
            <div className="font-medium">What it can see</div>
            <div className="flex gap-1.5">
              {(["all", "some"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setScope(v)}
                  className={cn("rounded-full px-3 py-1 text-xs", scope === v ? "bg-foreground text-background" : "bg-muted text-muted-foreground")}
                >
                  {v === "all" ? "All projects" : "Only chosen"}
                </button>
              ))}
            </div>
            {scope === "some" ? (
              <div className="grid grid-cols-2 gap-1">
                {projects.map((p, i) => (
                  <label key={p.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent">
                    <input type="checkbox" defaultChecked={i < 3} />
                    <ProjectGlyph project={p} className="size-4 text-[8px]" />
                    {p.name}
                  </label>
                ))}
              </div>
            ) : null}
          </section>
          <Row title="Start and continue chats" hint="Opens new chats for tasks and reads their results." on />
          <Row title="Act without asking" hint="Off: deploys, deleting and payments always wait for your OK." />
          <Row title="Daily summary at 9:00" hint="What finished, what waits for you — here and in Telegram." on />
          <section className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div>
              <div className="font-medium">Model</div>
              <div className="text-xs text-muted-foreground">Uno AI · Claude Sonnet</div>
            </div>
            <Button size="xs" variant="outline">
              Change
            </Button>
          </section>
          <section className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div>
              <div className="font-medium">Instructions</div>
              <div className="text-xs text-muted-foreground">~/UNO.md — who you are, how to answer, what to never do</div>
            </div>
            <Button size="xs" variant="outline">
              Edit
            </Button>
          </section>
        </DialogPanel>
        <DialogFooter>
          {variant === "b2" && thread ? (
            <Button
              variant="destructive-outline"
              size="sm"
              className="mr-auto"
              onClick={() => {
                setAssistant(thread.id, false);
                close(null);
              }}
            >
              Stop being an assistant
            </Button>
          ) : null}
          <Button size="sm" onClick={() => close(null)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Row({ title, hint, on }: { title: string; hint: string; on?: boolean }) {
  return (
    <section className="flex items-center justify-between gap-3">
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      <Switch defaultChecked={on ?? false} />
    </section>
  );
}
