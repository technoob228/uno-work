/**
 * "Home folder ▾" on a chat that hasn't been sent yet (0.0.82), extended:
 * recent folders, projects, and the click-through tree right inside the
 * popover (no T3 palette, no typing a path). Picking a folder that isn't a
 * project yet makes it one — in A2 that is the only way projects appear.
 */
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ClockIcon, FolderOpenIcon, FolderSearchIcon } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { RECENT_FOLDERS, type Thread } from "../data";
import { useProject, useProto } from "../store";
import { ProjectGlyph } from "./bits";
import { FolderBrowser } from "./FolderBrowser";

export function FolderChip({ thread }: { thread: Thread }) {
  const project = useProject(thread.projectId);
  const projects = useProto((s) => s.projects);
  const moveDraft = useProto((s) => s.moveDraft);
  const addProject = useProto((s) => s.addProject);
  const toast = useProto((s) => s.toast);
  const newVariant = useProto((s) => s.newVariant);
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  if (!thread.draft) {
    return (
      <span className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground">
        <ProjectGlyph project={project} className="size-4 text-[8px]" />
        {project.name}
      </span>
    );
  }

  const pickPath = (path: string, name: string) => {
    const p = addProject({ name: path === "~" ? "Home folder" : name, path, source: "folder" });
    moveDraft(thread.id, p.id);
    setOpen(false);
    setBrowsing(false);
    if (!projects.some((x) => x.path === path)) {
      toast(`Chat moved to ${name}`, newVariant === "a2" ? "It's now in the project list — no need to add it." : undefined);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setBrowsing(false);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-accent",
              open && "bg-accent",
            )}
          >
            <ProjectGlyph project={project} className="size-4 text-[8px]" />
            {project.name}
            <ChevronDownIcon className="size-3 text-muted-foreground" />
          </button>
        }
      />
      <PopoverPopup align="start" sideOffset={6} className={cn(browsing ? "w-[420px]" : "w-72", "[&>div]:p-2")}>
        {browsing ? (
          <div className="flex flex-col gap-1">
            <button type="button" onClick={() => setBrowsing(false)} className="flex items-center gap-1 self-start rounded px-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronLeftIcon className="size-3.5" /> Back
            </button>
            <FolderBrowser compact pickLabel="Work here" onPick={(path, name) => pickPath(path, name)} />
          </div>
        ) : (
          <div className="flex flex-col text-sm">
            <div className="px-2 pt-1 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/80">Where this chat works</div>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  moveDraft(thread.id, p.id);
                  setOpen(false);
                }}
                className="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-accent"
              >
                <ProjectGlyph project={p} className="size-4.5" />
                <span className="flex-1 truncate">{p.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">{p.path}</span>
                {p.id === thread.projectId ? <CheckIcon className="size-3.5 text-primary" /> : null}
              </button>
            ))}
            <div className="mt-1 px-2 pt-1.5 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/80">Recent folders</div>
            {RECENT_FOLDERS.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => pickPath(path, path.split("/").pop()!)}
                className="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-accent"
              >
                <ClockIcon className="size-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{path.replace("~/", "")}</span>
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            <button type="button" onClick={() => setBrowsing(true)} className="flex h-8 items-center gap-2 rounded-md px-2 text-left hover:bg-accent">
              {newVariant === "a2" ? <FolderSearchIcon className="size-4 text-muted-foreground" /> : <FolderOpenIcon className="size-4 text-muted-foreground" />}
              Browse…
            </button>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
