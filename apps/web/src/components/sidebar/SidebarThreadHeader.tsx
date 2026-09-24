/**
 * The sidebar header: one row holding search, project scope and "New ▾"
 * (0.0.83: one button instead of the new-chat / new-project icon pair).
 * Ported from upstream T3 Code (#11315); the icon button is a plain button
 * here because this fork's SidebarMenuButton has no icon size.
 *
 * Search owns the row's text and spans it. Project scope collapses to an icon
 * that sits with new-project and new-thread as a segmented group at the end.
 * The scope icon swaps to the project favicon while a project is selected,
 * so the header still names the scope after the row that showed it is gone.
 *
 * The scope picker itself is passed in: its combobox state lives with the rest
 * of the sidebar's scope logic. `searchFieldRef` lands on the search field so
 * the picker's popup can anchor to that width rather than to its 28px trigger.
 */
import { SearchIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  /** Lands on the search field so a popup can anchor to its width. */
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  /** Without projects there is nothing to scope, so those controls stay out. */
  hasProjects: boolean;
  /** The project scope combobox, rendered as the first icon of the group. */
  projectScope: ReactNode;
  /** "New ▾": new chat in the home folder; the arrow opens projects. */
  newButton: ReactNode;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  searchFieldRef,
  hasProjects,
  projectScope,
  newButton,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;

  return (
    <div className="flex items-center gap-1">
      <div
        ref={searchFieldRef}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <SearchIcon className="size-4 shrink-0 text-[var(--sidebar-icon-color)]" />
        <Input
          ref={searchInputRef}
          nativeInput
          unstyled
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search"
          aria-label="Search chats"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
          aria-activedescendant={
            activeResultExists
              ? `sidebar-thread-search-result-${activeSearchResultIndex}`
              : undefined
          }
          className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-[var(--sidebar-icon-color)]"
        />
        {isSearching ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="size-5 shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-foreground"
            aria-label="Clear chat search"
            onClick={() => {
              onClearSearch();
              searchInputRef.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      {hasProjects ? (
        <div className="flex shrink-0 items-center rounded-md bg-sidebar-control-surface/60 p-px">
          {projectScope}
        </div>
      ) : null}
      {newButton}
    </div>
  );
}

/**
 * Icon button with a tooltip, sized for the header's segmented pair. Spreads
 * unknown props through so it can serve as a popup trigger's render target,
 * which injects its own handlers, ref and aria state.
 */
export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  /** Accessible name; also the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<ComponentProps<"button">, "children" | "className" | "aria-label">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            {...rest}
            className={cn(
              "relative inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[popup-open]:bg-sidebar-row-hover data-[popup-open]:text-foreground [&_svg:not([class*='size-'])]:size-4",
              className,
            )}
          />
        }
      >
        {children}
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
