/**
 * Adding a project without the T3 palette: pick where it starts from —
 * a folder on this computer (click-through tree fenced to the home folder),
 * empty, GitHub or a template — and land in a new chat inside it.
 * A1 shows it as a dialog; A3 as a full page.
 */
import { ChevronLeftIcon, FolderOpenIcon, GithubIcon, LayoutTemplateIcon, LockIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/utils";
import { GITHUB_REPOS, TEMPLATES, type Project } from "../data";
import { useProto } from "../store";
import { FolderBrowser } from "./FolderBrowser";
import { PageHeader } from "./bits";

type Source = "folder" | "empty" | "github" | "template";

const SOURCES: ReadonlyArray<{ id: Source; title: string; hint: string; Icon: typeof PlusIcon }> = [
  { id: "folder", title: "A folder on this computer", hint: "Something you already have in your home folder", Icon: FolderOpenIcon },
  { id: "empty", title: "Empty project", hint: "A new folder in ~/projects, named for you", Icon: PlusIcon },
  { id: "github", title: "From GitHub", hint: "Clone one of your repositories", Icon: GithubIcon },
  { id: "template", title: "From a template", hint: "Website, Telegram bot, web app, data", Icon: LayoutTemplateIcon },
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9а-я]+/gi, "-")
    .replace(/^-|-$/g, "");

export function NewProjectFlow({ onDone }: { onDone: () => void }) {
  const addProject = useProto((s) => s.addProject);
  const newChat = useProto((s) => s.newChat);
  const toast = useProto((s) => s.toast);
  const [source, setSource] = useState<Source | null>(null);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<string | null>(null);
  const [cloning, setCloning] = useState<string | null>(null);

  const finish = (input: { name: string; path: string; source: Project["source"] }) => {
    const p = addProject(input);
    onDone();
    newChat(p.id);
    toast(`Project “${p.name}” added`, `${p.path} · a new chat is open in it`);
  };

  if (!source) {
    return (
      <div className="grid grid-cols-2 gap-2.5">
        {SOURCES.map(({ id, title, hint, Icon }) => (
          <button key={id} type="button" onClick={() => setSource(id)} className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/50">
            <span className="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4.5" />
            </span>
            <span className="text-sm font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </button>
        ))}
      </div>
    );
  }

  const back = (
    <button type="button" onClick={() => setSource(null)} className="mb-3 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ChevronLeftIcon className="size-3.5" /> All options
    </button>
  );

  if (source === "folder") {
    return (
      <div>
        {back}
        <FolderBrowser pickLabel="Make it a project" onPick={(path, n) => finish({ name: n, path, source: "folder" })} />
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <LockIcon className="size-3" /> Only folders inside your home folder. System folders are hidden.
        </p>
      </div>
    );
  }

  if (source === "github") {
    return (
      <div>
        {back}
        <div className="mb-2 text-xs text-muted-foreground">Connected as <b>mikhail</b> · repositories you can read</div>
        <ul className="flex flex-col gap-1">
          {GITHUB_REPOS.map((r) => (
            <li key={r}>
              <button
                type="button"
                disabled={cloning !== null}
                onClick={() => {
                  setCloning(r);
                  setTimeout(() => finish({ name: r.split("/")[1]!, path: `~/projects/${r.split("/")[1]}`, source: "github" }), 1100);
                }}
                className="flex h-10 w-full items-center gap-2.5 rounded-lg border px-3 text-left text-sm hover:bg-accent"
              >
                <GithubIcon className="size-4" />
                <span className="flex-1">{r}</span>
                {cloning === r ? <span className="text-xs text-muted-foreground">Cloning into ~/projects/{r.split("/")[1]}…</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const finalName = slug(name) || (template ? `my-${template}` : "");
  return (
    <div className="flex flex-col gap-3">
      {back}
      {source === "template" ? (
        <div className="grid grid-cols-2 gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTemplate(t.id)}
              className={cn("flex items-start gap-2.5 rounded-xl border p-3 text-left hover:bg-accent/50", template === t.id && "border-primary ring-2 ring-primary/20")}
            >
              <span className="text-xl leading-none">{t.glyph}</span>
              <span>
                <span className="block text-sm font-medium">{t.name}</span>
                <span className="block text-xs text-muted-foreground">{t.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={template ? `my-${template}` : "e.g. price-monitor"} autoFocus />
        <span className="text-xs text-muted-foreground">Folder: ~/projects/{finalName || "…"}</span>
      </label>
      <Button
        className="self-end"
        size="sm"
        disabled={!finalName || (source === "template" && !template)}
        onClick={() => finish({ name: finalName, path: `~/projects/${finalName}`, source: source === "template" ? "template" : "empty" })}
      >
        Create project
      </Button>
    </div>
  );
}

export function NewProjectDialog() {
  const open = useProto((s) => s.newProjectOpen);
  const setOpen = useProto((s) => s.openNewProject);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>A project is a folder with its chats. Everything the agent makes stays in it.</DialogDescription>
        </DialogHeader>
        <DialogPanel>{open ? <NewProjectFlow onDone={() => setOpen(false)} /> : null}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function NewProjectPage() {
  const go = useProto((s) => s.go);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader icon={<PlusIcon />} title="New project" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-10">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Start a project</h1>
            <p className="text-sm text-muted-foreground">A project is a folder with its chats, files and apps. It shows up as a group in the sidebar.</p>
          </div>
          <NewProjectFlow onDone={() => go({ kind: "home" })} />
        </div>
      </div>
    </div>
  );
}
