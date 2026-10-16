/**
 * Sidebar D: the one line over the chats (Misha 16.10, w0138 point 5). It used
 * to be two quiet labels, "Chats" and "Projects", that nobody could place.
 * Now the title says what the list shows — "Projects" (folders), "All
 * projects ▾" (one list with a project filter) or "Inbox" (by status) — and on
 * the right sit Add a project and New chat, New chat rightmost.
 *
 * Where the view is picked is a switch of the mock (`sidebarViewSwitch`):
 * "header" — a click on the title opens the menu (views, Group by computer,
 * the project filter); "settings" — only Settings → General changes the view,
 * and the title opens a menu only in one list, for its project filter.
 *
 * New chat came back here on 15.10 (Misha): 0.0.133 took the icon off the
 * header to give the account name room, and people lost the obvious way to
 * start a chat. Its tooltip names the person's own shortcut (chat.new).
 */
import { ChevronDownIcon, FolderPlusIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SIDEBAR_D_VIEW_OPTIONS, type SidebarDView } from "./sidebarDView.logic";

const BAR_BUTTON_CLASS =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** "New chat ⌘N" — or plain "New chat" when nothing is bound. */
export function newChatTooltipLabel(shortcutLabel: string | null): string {
  return shortcutLabel ? `New chat ${shortcutLabel}` : "New chat";
}

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

export interface SidebarDProjectFilterOption {
  /** The project's group key, or null for all projects. */
  readonly key: string | null;
  readonly label: string;
  /** Computer chips of a project that lives elsewhere. */
  readonly adornment?: ReactNode;
}

const TITLE_CLASS = "min-w-0 truncate text-xs font-medium text-sidebar-muted-foreground/80";

export function SidebarDChatsBar(props: {
  view: SidebarDView;
  /** What the list shows: "Projects", "All projects", a project's name, "Inbox". */
  title: string;
  /** The title opens the view menu (variant A); else only Settings changes the view. */
  viewInHeader: boolean;
  onViewChange: (view: SidebarDView) => void;
  /** One list: its project filter (null elsewhere). */
  projectFilter: {
    readonly value: string | null;
    readonly options: ReadonlyArray<SidebarDProjectFilterOption>;
    readonly onChange: (key: string | null) => void;
  } | null;
  /** Offered with several computers; null — not offered. */
  groupByComputer: { readonly checked: boolean; readonly onChange: (on: boolean) => void } | null;
  /** Controlled open state of the title menu (the mock's "Show" opens it). */
  menuOpen?: boolean;
  onMenuOpenChange?: (open: boolean) => void;
  onNewChat: (event: ReactMouseEvent) => void;
  /** The person's chat.new shortcut (e.g. "⌘N"); null — none bound. */
  newChatShortcutLabel: string | null;
  onAddProject: () => void;
}) {
  const showViews = props.viewInHeader;
  const showFilter = props.projectFilter !== null;
  const showGroupBy = props.viewInHeader && props.groupByComputer !== null;
  const hasMenu = showViews || showFilter;
  return (
    <li
      className="mt-2 flex h-7 list-none items-center gap-0.5 pr-1 pl-1"
      data-testid="sidebar-d-chats-bar"
    >
      <div className="flex min-w-0 flex-1 items-center">
        {hasMenu ? (
          <Menu
            {...(props.menuOpen !== undefined ? { open: props.menuOpen } : {})}
            {...(props.onMenuOpenChange ? { onOpenChange: props.onMenuOpenChange } : {})}
          >
            <MenuTrigger
              render={
                <button
                  type="button"
                  data-testid="sidebar-d-view-trigger"
                  aria-label={`${props.title} — change what the list shows`}
                  className="group/view flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-row-hover"
                />
              }
            >
              <span className={cn(TITLE_CLASS, "group-hover/view:text-foreground")}>
                {props.title}
              </span>
              <ChevronDownIcon
                aria-hidden
                className="size-3 shrink-0 text-sidebar-muted-foreground/70 group-hover/view:text-foreground"
              />
            </MenuTrigger>
            <MenuPopup
              align="start"
              side="bottom"
              sideOffset={4}
              className="min-w-56"
              data-testid="sidebar-d-view-menu"
            >
              {showViews ? (
                <MenuGroup>
                  <MenuGroupLabel>Show chats as</MenuGroupLabel>
                  <MenuRadioGroup
                    value={props.view}
                    onValueChange={(value) => props.onViewChange(value as SidebarDView)}
                  >
                    {SIDEBAR_D_VIEW_OPTIONS.map((option) => (
                      <MenuRadioItem
                        key={option.id}
                        value={option.id}
                        closeOnClick
                        data-testid={`sidebar-d-view-${option.id}`}
                      >
                        <span className="flex items-baseline gap-2">
                          <span>{option.label}</span>
                          <span className="truncate text-xs text-muted-foreground/70">
                            {option.hint}
                          </span>
                        </span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              ) : null}
              {showGroupBy ? (
                <>
                  <MenuSeparator />
                  <MenuCheckboxItem
                    checked={props.groupByComputer!.checked}
                    disabled={props.view === "inbox"}
                    closeOnClick
                    onCheckedChange={(checked) => props.groupByComputer!.onChange(Boolean(checked))}
                    data-testid="sidebar-d-group-by-computer"
                  >
                    Group by computer
                  </MenuCheckboxItem>
                </>
              ) : null}
              {showFilter ? (
                <>
                  {showViews ? <MenuSeparator /> : null}
                  <MenuGroup>
                    <MenuGroupLabel>Project</MenuGroupLabel>
                    <MenuRadioGroup
                      value={props.projectFilter!.value ?? ""}
                      onValueChange={(value) =>
                        props.projectFilter!.onChange(value === "" ? null : String(value))
                      }
                    >
                      {props.projectFilter!.options.map((option) => (
                        <MenuRadioItem
                          key={option.key ?? ""}
                          value={option.key ?? ""}
                          closeOnClick
                          data-testid={`sidebar-d-filter-${option.key ?? "all"}`}
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{option.label}</span>
                            {option.adornment}
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuGroup>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : (
          <span className={cn(TITLE_CLASS, "px-1.5")} data-testid="sidebar-d-view-title">
            {props.title}
          </span>
        )}
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
  );
}
