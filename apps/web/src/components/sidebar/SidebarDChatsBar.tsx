/**
 * Sidebar D: the one line over the chats (Misha 16.10, w0138 point 5). It used
 * to be two quiet labels, "Chats" and "Projects", that nobody could place.
 * Now the title says what the list shows — "All projects", "Projects",
 * "landing", "2 projects · by status" — and on the right sit Add a project and
 * New chat, New chat rightmost. No other button: the title is the one way in.
 *
 * Behind the title (Misha's follow-up, ported from icp3/sidebar-v2 and
 * icp3/multi-computer): Group by — none (one list), Project, Status, Computer
 * in the order picked; Projects and Computers as multi-pick chips. While a
 * filter is on, one small chip under the title names it, with × to clear.
 *
 * Where grouping is picked is a switch of the mock (`sidebarViewSwitch`):
 * "header" — in this menu; "settings" — only in Settings, and the title's
 * menu keeps just the filters.
 *
 * New chat came back here on 15.10 (Misha): 0.0.133 took the icon off the
 * header to give the account name room, and people lost the obvious way to
 * start a chat. Its tooltip names the person's own shortcut (chat.new).
 */
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  FolderIcon,
  FolderPlusIcon,
  LaptopIcon,
  ListIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { create } from "zustand";

import { cn } from "~/lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SIDEBAR_GROUP_LEVELS,
  levelsLabel,
  moveLevel,
  toggleFilter,
  toggleLevel,
  type SidebarGroupLevel,
} from "./sidebarDView.logic";

const BAR_BUTTON_CLASS =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** "New chat ⌘N" — or plain "New chat" when nothing is bound. */
export function newChatTooltipLabel(shortcutLabel: string | null): string {
  return shortcutLabel ? `New chat ${shortcutLabel}` : "New chat";
}

/** The title's menu, open or not (the mock's "Show" buttons open it). */
export const useSidebarDViewMenu = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

function BarButton(props: {
  label: string;
  tooltip: string;
  testId: string;
  onClick: (event: ReactMouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            data-testid={props.testId}
            onClick={props.onClick}
            className={BAR_BUTTON_CLASS}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export interface SidebarDPickOption {
  readonly key: string;
  readonly label: string;
  /** A project's computer chips, a computer's own chip. */
  readonly adornment?: ReactNode;
  readonly icon?: ReactNode;
  /** Grey: a computer asleep or out of reach. */
  readonly dimmed?: boolean;
}

const LEVEL_ICON: Readonly<Record<SidebarGroupLevel, ReactNode>> = {
  project: <FolderIcon />,
  status: <CircleDashedIcon />,
  computer: <LaptopIcon />,
};

const TITLE_CLASS = "min-w-0 truncate text-xs font-medium text-sidebar-muted-foreground/80";

function MenuLabel(props: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-1 pb-1">
      <span className="text-xs font-medium text-muted-foreground">{props.children}</span>
      {props.aside ? (
        <span className="ml-auto truncate text-xs text-muted-foreground/70">{props.aside}</span>
      ) : null}
    </div>
  );
}

function PickChip(props: {
  on: boolean;
  onClick: () => void;
  testId: string;
  dimmed?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      onClick={props.onClick}
      data-testid={props.testId}
      className={cn(
        "inline-flex h-6 max-w-full cursor-pointer items-center gap-1 rounded-full border px-2 text-xs outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3 [&_svg]:shrink-0",
        props.on
          ? "border-foreground/25 bg-accent text-foreground"
          : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        props.dimmed && !props.on && "opacity-60",
      )}
    >
      {props.children}
    </button>
  );
}

function PickChips(props: {
  testId: string;
  options: ReadonlyArray<SidebarDPickOption>;
  picked: ReadonlyArray<string> | null;
  onChange: (picked: ReadonlyArray<string> | null) => void;
}) {
  const all = props.options.map((option) => option.key);
  return (
    <div className="flex flex-wrap gap-1 px-1" data-testid={props.testId}>
      <PickChip
        on={props.picked === null}
        onClick={() => props.onChange(null)}
        testId={`${props.testId}-all`}
      >
        All
      </PickChip>
      {props.options.map((option) => (
        <PickChip
          key={option.key}
          on={props.picked?.includes(option.key) ?? false}
          dimmed={option.dimmed}
          onClick={() => props.onChange(toggleFilter(props.picked, option.key, all))}
          testId={`${props.testId}-${option.key}`}
        >
          {option.icon}
          <span className="truncate">{option.label}</span>
          {option.adornment}
        </PickChip>
      ))}
    </div>
  );
}

function GroupLevels(props: {
  levels: ReadonlyArray<SidebarGroupLevel>;
  computerAvailable: boolean;
  onChange: (levels: ReadonlyArray<SidebarGroupLevel>) => void;
}) {
  const { levels } = props;
  const offered = SIDEBAR_GROUP_LEVELS.filter(
    (item) => item.id !== "computer" || props.computerAvailable,
  ).map((item) => item.id);
  const shown = levels.filter((level) => offered.includes(level));
  // Picked levels in their order, then the others.
  const rows = [...shown, ...offered.filter((id) => !shown.includes(id))];
  const rowClass =
    "flex h-7 items-center gap-1 rounded-md pr-0.5 hover:bg-accent/60 [&_svg]:size-3.5 [&_svg]:shrink-0";
  const labelClass = "flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 text-sm";
  return (
    <div data-testid="sidebar-d-group-levels">
      <MenuLabel aside={shown.length > 1 ? levelsLabel(shown) : null}>Group by</MenuLabel>
      <ul className="flex flex-col">
        <li className={rowClass} data-testid="sidebar-d-level-none">
          <label className={labelClass}>
            <Checkbox
              checked={shown.length === 0}
              onCheckedChange={() => props.onChange([])}
              aria-label="No grouping — one list"
            />
            <span className="text-muted-foreground">
              <ListIcon />
            </span>
            <span className="truncate">None</span>
            <span className="truncate text-xs text-muted-foreground/70">one list, newest first</span>
          </label>
        </li>
        {rows.map((id) => {
          const on = shown.includes(id);
          const index = shown.indexOf(id);
          const name = SIDEBAR_GROUP_LEVELS.find((item) => item.id === id)!.name;
          return (
            <li key={id} className={rowClass} data-testid={`sidebar-d-level-${id}`}>
              <label className={labelClass}>
                <Checkbox
                  checked={on}
                  onCheckedChange={() => props.onChange(toggleLevel(shown, id))}
                  aria-label={`Group by ${name}`}
                />
                <span className="text-muted-foreground">{LEVEL_ICON[id]}</span>
                <span className="truncate">{name}</span>
                {on && shown.length > 1 ? (
                  <span className="text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                ) : null}
              </label>
              {on && shown.length > 1 ? (
                <>
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => props.onChange(moveLevel(shown, id, -1))}
                    aria-label={`Move ${name} up`}
                    className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ArrowUpIcon />
                  </button>
                  <button
                    type="button"
                    disabled={index === shown.length - 1}
                    onClick={() => props.onChange(moveLevel(shown, id, 1))}
                    aria-label={`Move ${name} down`}
                    className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                  >
                    <ArrowDownIcon />
                  </button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SidebarDChatsBar(props: {
  /** What the list shows: "All projects", "Projects", "landing", "2 projects · by status". */
  title: string;
  /** Grouping is picked in the title's menu (variant A); else only in Settings. */
  groupInHeader: boolean;
  /** The grouping as chosen (Computer kept even while only one computer is in view). */
  levels: ReadonlyArray<SidebarGroupLevel>;
  /** Computer grouping and the computer filter: only with 2+ computers. */
  multiComputer: boolean;
  onLevelsChange: (levels: ReadonlyArray<SidebarGroupLevel>) => void;
  projects: ReadonlyArray<SidebarDPickOption>;
  pickedProjects: ReadonlyArray<string> | null;
  onProjectsChange: (picked: ReadonlyArray<string> | null) => void;
  computers: ReadonlyArray<SidebarDPickOption>;
  pickedComputers: ReadonlyArray<string> | null;
  onComputersChange: (picked: ReadonlyArray<string> | null) => void;
  /** The active filter in a few words ("landing · MacBook"); null — none. */
  filterChip: string | null;
  onClearFilters: () => void;
  onNewChat: (event: ReactMouseEvent) => void;
  /** The person's chat.new shortcut (e.g. "⌘N"); null — none bound. */
  newChatShortcutLabel: string | null;
  onAddProject: () => void;
}) {
  const open = useSidebarDViewMenu((state) => state.open);
  const setOpen = useSidebarDViewMenu((state) => state.setOpen);
  const showComputers = props.multiComputer && props.computers.length > 1;
  return (
    <>
      <li
        className="mt-2 flex h-7 list-none items-center gap-0.5 pr-1 pl-1"
        data-testid="sidebar-d-chats-bar"
      >
        <div className="flex min-w-0 flex-1 items-center">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              data-testid="sidebar-d-view-trigger"
              aria-label={`${props.title} — group and filter chats`}
              className="group/view flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-row-hover"
            >
              <span className={cn(TITLE_CLASS, "group-hover/view:text-foreground")}>
                {props.title}
              </span>
              <ChevronDownIcon
                aria-hidden
                className="size-3 shrink-0 text-sidebar-muted-foreground/70 group-hover/view:text-foreground"
              />
            </PopoverTrigger>
            <PopoverPopup
              side="bottom"
              align="start"
              className="w-[min(17rem,calc(100vw-1.5rem))] [--viewport-inline-padding:--spacing(2)]"
              data-testid="sidebar-d-view-menu"
            >
              <div className="-my-2 flex max-h-[calc(var(--available-height)-2rem)] flex-col gap-3 overflow-y-auto">
                {props.groupInHeader ? (
                  <GroupLevels
                    levels={props.levels}
                    computerAvailable={props.multiComputer}
                    onChange={props.onLevelsChange}
                  />
                ) : null}
                <div
                  className={cn(props.groupInHeader && "border-t border-border/70 pt-2.5")}
                >
                  <MenuLabel>Projects</MenuLabel>
                  <PickChips
                    testId="sidebar-d-pick-project"
                    options={props.projects}
                    picked={props.pickedProjects}
                    onChange={props.onProjectsChange}
                  />
                </div>
                {showComputers ? (
                  <div className="border-t border-border/70 pt-2.5">
                    <MenuLabel>Computers</MenuLabel>
                    <PickChips
                      testId="sidebar-d-pick-computer"
                      options={props.computers}
                      picked={props.pickedComputers}
                      onChange={props.onComputersChange}
                    />
                    <p className="px-1 pt-1.5 text-xs leading-snug text-muted-foreground/80">
                      A project on several computers is one project.
                    </p>
                  </div>
                ) : null}
              </div>
            </PopoverPopup>
          </Popover>
        </div>
        <BarButton
          label="Add a project"
          tooltip="Add a project"
          testId="sidebar-d-add-project"
          onClick={() => props.onAddProject()}
        >
          <FolderPlusIcon className="size-3.5" />
        </BarButton>
        <BarButton
          label="New chat"
          tooltip={newChatTooltipLabel(props.newChatShortcutLabel)}
          testId="sidebar-d-new-chat"
          onClick={props.onNewChat}
        >
          <SquarePenIcon className="size-3.5" />
        </BarButton>
      </li>
      {props.filterChip ? (
        <li className="flex list-none px-1.5 pt-0.5 pb-1" data-testid="sidebar-d-filter-chip">
          <button
            type="button"
            onClick={props.onClearFilters}
            aria-label={`Show everything, not only ${props.filterChip}`}
            className="inline-flex h-5 max-w-full cursor-pointer items-center gap-1 rounded-full bg-accent pr-1 pl-2 text-[11px] font-medium text-foreground/80 hover:bg-sidebar-row-hover hover:text-foreground"
          >
            <span className="truncate">{props.filterChip}</span>
            <XIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ) : null}
    </>
  );
}
