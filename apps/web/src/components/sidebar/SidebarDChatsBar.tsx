/**
 * Sidebar D: the line over the chats — "New chat" and "Add a project" side by
 * side (the dialog then asks where the project comes from: the laptop, this
 * computer, Cloud storage, GitHub). How the chats are laid out — classic or
 * inbox — is a setting, not a control here (Misha 11.10).
 *
 * New chat came back here on 15.10 (Misha): 0.0.133 took the icon off the
 * header to give the account name room, and people lost the obvious way to
 * start a chat. Its tooltip names the person's own shortcut (chat.new).
 */
import { FolderPlusIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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

export function SidebarDChatsBar(props: {
  onNewChat: (event: ReactMouseEvent) => void;
  /** The person's chat.new shortcut (e.g. "⌘N"); null — none bound. */
  newChatShortcutLabel: string | null;
  onAddProject: () => void;
}) {
  return (
    <li
      className="mt-2 flex h-7 list-none items-center gap-0.5 pr-1 pl-2.5"
      data-testid="sidebar-d-chats-bar"
    >
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground/70">
        Chats
      </span>
      <BarButton
        label="New chat"
        tooltip={newChatTooltipLabel(props.newChatShortcutLabel)}
        testId="sidebar-d-new-chat"
        onClick={props.onNewChat}
      >
        <SquarePenIcon className="size-3.5" />
      </BarButton>
      <BarButton
        label="Add a project"
        tooltip="Add a project"
        testId="sidebar-d-add-project"
        onClick={() => props.onAddProject()}
      >
        <FolderPlusIcon className="size-3.5" />
      </BarButton>
    </li>
  );
}
