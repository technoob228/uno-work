/**
 * The full-width "Add a project" under "All chats" while the person has no
 * project of their own (Misha 28.10, sidebarAddProject.logic.ts): the same
 * words, folder and light card as Home's "Add a project" pill, so it reads as
 * the same thing. It opens the same dialog as the small folder icon on the
 * chats bar, which stays.
 */
import { FolderIcon } from "lucide-react";

export const SIDEBAR_ADD_PROJECT_HINT = "Open a folder or a GitHub repo";

export function SidebarAddProjectButton(props: { onAddProject: () => void }) {
  return (
    <li className="list-none px-0.5 pt-1 pb-2" data-testid="sidebar-add-project-cta">
      <button
        type="button"
        onClick={() => props.onAddProject()}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border bg-card px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none"
        data-testid="sidebar-add-project-button"
      >
        <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">Add a project</span>
          <span className="truncate text-xs text-sidebar-muted-foreground">
            {SIDEBAR_ADD_PROJECT_HINT}
          </span>
        </span>
      </button>
    </li>
  );
}
