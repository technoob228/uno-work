/**
 * "New ▾" — the one way to start something from the sidebar. The button is a
 * new chat in the home folder (the "Home folder ▾" chip on the chat moves it);
 * the arrow opens: a new chat in one of the recent projects, and New project
 * (a folder on this computer, empty, from GitHub).
 */
import { ChevronDownIcon, FolderOpenIcon, PlusIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { GitHubIcon } from "../Icons";
import { type NewProjectStep, openNewProject } from "../../navigation/newProjectStore";
import { cn } from "../../lib/utils";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarNewButtonProject {
  readonly key: string;
  readonly name: string;
  readonly onSelect: () => void;
}

const NEW_PROJECT_ITEMS: ReadonlyArray<{
  step: NewProjectStep;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { step: "folder", label: "From a folder on this computer", Icon: FolderOpenIcon },
  { step: "empty", label: "Empty project", Icon: PlusIcon },
  { step: "github", label: "From GitHub", Icon: GitHubIcon },
];

export function SidebarNewButton(props: {
  onNewChat: (event: ReactMouseEvent) => void;
  disabled: boolean;
  shortcutLabel: string | null | undefined;
  /** Shift+click (or this shortcut): a new chat in the open chat's project. */
  inProjectShortcutLabel?: string | null | undefined;
  recentProjects: ReadonlyArray<SidebarNewButtonProject>;
}) {
  const chatLabel = props.shortcutLabel
    ? `New chat in your home folder (${props.shortcutLabel})`
    : "New chat in your home folder";
  return (
    <div
      className="flex h-7 shrink-0 items-stretch overflow-hidden rounded-md bg-primary text-primary-foreground shadow-xs"
      data-testid="sidebar-new"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={chatLabel}
              disabled={props.disabled}
              onClick={props.onNewChat}
              data-testid="sidebar-new-chat"
              className="inline-flex cursor-pointer items-center gap-1.5 pr-2 pl-2.5 text-xs font-semibold outline-hidden transition-colors hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
            />
          }
        >
          <SquarePenIcon className="size-3.5" />
          New
        </TooltipTrigger>
        <TooltipPopup side="top">
          <span className="flex flex-col gap-0.5">
            <span>{chatLabel}</span>
            <span className="text-muted-foreground">
              In the open chat's project: Shift+click
              {props.inProjectShortcutLabel ? ` (${props.inProjectShortcutLabel})` : ""}
            </span>
          </span>
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          aria-label="More ways to start"
          data-testid="sidebar-new-menu"
          className={cn(
            "inline-flex w-6 cursor-pointer items-center justify-center border-l border-primary-foreground/25 outline-hidden transition-colors hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-primary/80",
          )}
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-60">
          <MenuItem onClick={(event) => props.onNewChat(event as unknown as ReactMouseEvent)}>
            <SquarePenIcon />
            <span className="flex-1">New chat</span>
            <span className="text-[11px] text-muted-foreground">in Home folder</span>
          </MenuItem>
          {props.recentProjects.length > 0 ? (
            <MenuGroup>
              <MenuGroupLabel>New chat in a project</MenuGroupLabel>
              {props.recentProjects.map((project) => (
                <MenuItem key={project.key} onClick={project.onSelect}>
                  <span
                    aria-hidden
                    className="grid size-4 shrink-0 place-items-center rounded bg-muted text-[9px] font-semibold uppercase"
                  >
                    {project.name.slice(0, 1)}
                  </span>
                  <span className="max-w-56 truncate">{project.name}</span>
                </MenuItem>
              ))}
            </MenuGroup>
          ) : null}
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>New project</MenuGroupLabel>
            {NEW_PROJECT_ITEMS.map(({ step, label, Icon }) => (
              <MenuItem
                key={step}
                onClick={() => openNewProject(step)}
                data-testid={`sidebar-new-project-${step}`}
              >
                <Icon className="size-4" />
                {label}
              </MenuItem>
            ))}
          </MenuGroup>
        </MenuPopup>
      </Menu>
    </div>
  );
}
