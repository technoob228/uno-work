/**
 * The sidebar with no chats yet still shows where work will live: each
 * project as a small group ("No chats yet", click = a new chat there), and —
 * while the setup's Project step is open — the project being named, before
 * it exists, with "Your project lives here" under it.
 */
import { ArrowUpIcon, ChevronDownIcon } from "lucide-react";
import { create } from "zustand";

import { cn } from "../../lib/utils";

interface SetupProjectPreviewState {
  /** The name typed on the Project step; null when that step isn't open. */
  readonly name: string | null;
  readonly setName: (name: string | null) => void;
}

export const useSetupProjectPreview = create<SetupProjectPreviewState>((set) => ({
  name: null,
  setName: (name) => set({ name }),
}));

export interface SidebarEmptyProject {
  readonly key: string;
  readonly name: string;
}

function Group({ name, fresh, onOpen }: { name: string; fresh: boolean; onOpen?: () => void }) {
  const initial = (name.trim()[0] ?? "P").toUpperCase();
  return (
    <li
      className={cn(
        "list-none rounded-lg",
        fresh && "bg-primary/[0.07] ring-1 ring-primary/15 ring-inset",
      )}
      data-testid={fresh ? "sidebar-project-preview" : "sidebar-empty-project"}
    >
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        title={onOpen ? `New chat in ${name}` : undefined}
        className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-sidebar-foreground enabled:cursor-pointer enabled:hover:bg-sidebar-row-hover"
      >
        <ChevronDownIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" aria-hidden />
        <span
          className={cn(
            "flex size-[18px] shrink-0 items-center justify-center rounded text-[10px] font-semibold",
            fresh ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
          aria-hidden
        >
          {initial}
        </span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="text-xs text-sidebar-muted-foreground tabular-nums">0</span>
      </button>
      <div className="pb-1.5 pl-[46px] text-xs text-sidebar-muted-foreground">No chats yet</div>
      {fresh ? (
        <div className="flex items-center gap-1 pb-1.5 pl-[30px] text-xs font-medium text-primary">
          <ArrowUpIcon className="size-3" aria-hidden />
          Your project lives here
        </div>
      ) : null}
    </li>
  );
}

export function SidebarEmptyProjects({
  projects,
  onOpen,
}: {
  projects: ReadonlyArray<SidebarEmptyProject>;
  onOpen: (key: string) => void;
}) {
  const preview = useSetupProjectPreview((state) => state.name);
  const previewName = preview === null ? null : preview.trim() || "my-project";
  const shown = projects.filter((project) => project.name !== previewName).slice(0, 6);
  if (previewName === null && shown.length === 0) return null;
  return (
    <ul role="list" className="flex flex-col gap-1 pt-1" aria-label="Projects">
      {previewName !== null ? <Group name={previewName} fresh /> : null}
      {shown.map((project) => (
        <Group
          key={project.key}
          name={project.name}
          fresh={false}
          onOpen={() => onOpen(project.key)}
        />
      ))}
    </ul>
  );
}
