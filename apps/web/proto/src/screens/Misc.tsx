/**
 * The smaller screens: an app opened from a notification, a project page
 * (A3), and Settings → Telegram & Slack (B3, where Telegram belongs to the
 * person instead of an assistant).
 */
import { FolderIcon, MessageSquareIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import { AppGlyph, PageHeader, ProjectGlyph, SlackGlyph, TelegramGlyph, ThreadDot, ago, appName, statusLabel } from "../parts/bits";
import { useProject, useProto } from "../store";

export function AppScreen({ appId }: { appId: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={<AppGlyph appId={appId} className="size-5 text-[8px]" />} title={appName(appId)} right={<span className="text-xs text-muted-foreground">opened from a notification</span>} />
      <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-6">
        {appId === "taskboard" ? (
          <div className="grid grid-cols-3 gap-4">
            {[
              ["To do", ["Invoices export", "Onboarding emails"]],
              ["In progress", ["Drag & drop", "Assignees"]],
              ["Done", ["Billing page ✨", "Login with Uno"]],
            ].map(([col, cards]) => (
              <div key={col as string} className="rounded-xl bg-background p-3 shadow-xs">
                <div className="mb-2 text-xs font-semibold text-muted-foreground">{col as string}</div>
                {(cards as string[]).map((c) => (
                  <div key={c} className={cn("mb-2 rounded-lg border bg-card p-2.5 text-sm", c.includes("✨") && "ring-2 ring-primary/40")}>
                    {c}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : appId === "notetaker" ? (
          <div className="mx-auto max-w-2xl rounded-xl bg-background p-6 shadow-xs">
            <div className="text-lg font-semibold">Call with Hector — 42 min</div>
            <div className="mb-4 text-xs text-muted-foreground">Today, 15:10 · Google Meet</div>
            <div className="mb-2 text-sm font-medium">Action items</div>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>Send GPU pricing for 4× H100</li>
              <li>Move the staging box to NL</li>
              <li>Share the DPA draft by Friday</li>
              <li>Trial for 3 teammates</li>
              <li>Follow-up call next Tuesday</li>
            </ul>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl rounded-xl bg-background p-6 text-sm text-muted-foreground shadow-xs">
            {appName(appId)} opens here, inside Uno Work.
          </div>
        )}
      </div>
    </div>
  );
}

export function ProjectScreen({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const threads = useProto((s) => s.threads).filter((t) => t.projectId === projectId && !t.assistant);
  const go = useProto((s) => s.go);
  const newChat = useProto((s) => s.newChat);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        icon={<ProjectGlyph project={project} className="size-5" />}
        title={project.name}
        right={
          <Button size="xs" onClick={() => newChat(projectId)}>
            <PlusIcon /> New chat here
          </Button>
        }
      >
        <span className="text-xs text-muted-foreground">{project.path}</span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-4xl grid-cols-[1fr_260px] gap-6 px-6 py-8">
          <section>
            <h2 className="mb-2 text-sm font-semibold">Chats</h2>
            {threads.length === 0 ? <p className="text-sm text-muted-foreground">No chats yet. Start one — it works in {project.path}.</p> : null}
            <ul className="flex flex-col gap-1">
              {threads.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => go({ kind: "chat", threadId: t.id })} className="flex h-10 w-full items-center gap-2.5 rounded-lg border bg-card px-3 text-left text-sm hover:bg-accent">
                    <ThreadDot thread={t} />
                    <span className="flex-1 truncate">{t.title}</span>
                    <span className={cn("text-xs", statusLabel(t).tone)}>{statusLabel(t).text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold">Files</h2>
            <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
              {["src", "public", "README.md", "package.json", ".env"].map((f) => (
                <li key={f} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent">
                  <FolderIcon className="size-3.5" /> {f}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export function TelegramSettingsScreen() {
  const linked = useProto((s) => s.telegramLinked);
  const setLinked = useProto((s) => s.setTelegramLinked);
  const threads = useProto((s) => s.threads).filter((t) => t.projectId === "home" && !t.assistant).slice(0, 3);
  const [what, setWhat] = useState({ needs: true, done: true, apps: false });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={<SettingsIcon />} title="Settings" >
        <span className="text-xs text-muted-foreground">› Telegram & Slack</span>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-6 py-8">
          <div>
            <h1 className="text-xl font-semibold">Telegram & Slack</h1>
            <p className="text-sm text-muted-foreground">
              Get what the Inbox shows in your messenger and answer from there. A reply continues that chat; a new message starts a chat in your Home folder.
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-xl border p-4">
            <TelegramGlyph className="size-8" />
            <div className="flex-1">
              <div className="font-medium">Telegram</div>
              <div className="text-xs text-muted-foreground">{linked ? "Connected as Mikhail T. · @UnoWorkBot" : "Not connected"}</div>
            </div>
            <Button size="sm" variant={linked ? "outline" : "default"} onClick={() => setLinked(!linked)}>
              {linked ? "Disconnect" : "Connect"}
            </Button>
          </div>
          <div className="flex items-center gap-3 rounded-xl border p-4">
            <SlackGlyph className="size-8" />
            <div className="flex-1">
              <div className="font-medium">Slack</div>
              <div className="text-xs text-muted-foreground">Not connected</div>
            </div>
            <Button size="sm">Add to Slack</Button>
          </div>
          <section className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="font-medium">What goes to Telegram</div>
            {(
              [
                ["needs", "Approvals and questions", "Approve / answer with a button right in Telegram"],
                ["done", "Finished and failed chats", "A short result with a link back"],
                ["apps", "App notifications", "Taskboard, Notetaker, Office comments…"],
              ] as const
            ).map(([k, t, h]) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">{t}</div>
                  <div className="text-xs text-muted-foreground">{h}</div>
                </div>
                <Switch checked={what[k]} onCheckedChange={(v) => setWhat({ ...what, [k]: v })} />
              </div>
            ))}
          </section>
          <section className="rounded-xl border bg-muted/30 p-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">How it looks in Telegram</div>
            <div className="flex flex-col gap-2 text-sm">
              <div className="w-fit max-w-[80%] rounded-2xl rounded-bl-md bg-background px-3 py-2 shadow-xs">
                ✅ <b>Список компьютеров Uno</b> — done. computers.xlsx, 12 machines.
                <div className="mt-1.5 flex gap-1.5 text-xs text-primary">Open in Uno</div>
              </div>
              <div className="w-fit max-w-[80%] self-end rounded-2xl rounded-br-md bg-sky-500 px-3 py-2 text-white">↩︎ Добавь туда колонку с тарифом</div>
              <div className="w-fit max-w-[80%] rounded-2xl rounded-bl-md bg-background px-3 py-2 shadow-xs">Continuing in “Список компьютеров Uno”…</div>
            </div>
          </section>
          <section>
            <div className="mb-1.5 text-xs text-muted-foreground">Recent chats that came from Telegram</div>
            {threads.map((t) => (
              <div key={t.id} className="flex items-center gap-2 py-1 text-sm">
                <MessageSquareIcon className="size-3.5 text-muted-foreground" /> {t.title}
                <span className="ml-auto text-xs text-muted-foreground">{ago(t.updatedMin)}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
