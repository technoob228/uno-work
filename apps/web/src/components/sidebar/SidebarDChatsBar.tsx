/**
 * Sidebar D: the one line over the chats (Misha 16.10, w0138 point 5; Labs
 * "Sidebar view menu" — off, LegacySidebarDChatsBar below as in 0.0.137). It used
 * to be two quiet labels, "Chats" and "Projects", that nobody could place.
 * Now the title is a button that says which chats are shown — "All chats",
 * "Chats · landing" — and on the right sit Add a project and New chat, New
 * chat rightmost. No other button: the title is the one way in.
 *
 * Its menu (critics 16.10, on `ui/menu`): four ready ways — One list, By
 * project, By status, By computer — and "Customize…" for Misha's Group by
 * with the order of levels (icp3/sidebar-v2); Projects and Computers as
 * submenus with checkboxes; Only mine (Misha 28.10) hides the chats agents,
 * Uno, assistants or apps run on their own (Sidebar.owner; 29.10: 0.0.161's
 * "Chats assistants started" went into it). A filter is said in the title
 * only, with × next to it to clear.
 *
 * The funnel by the title (Misha 31.10, as in T3 Code) is the short way to
 * the same project filter: two clicks to one project in any grouping. It and
 * the Projects submenu edit one choice, so each shows what the other did.
 *
 * Where grouping is picked is a switch of the mock (`sidebarViewSwitch`):
 * "header" — in this menu; "settings" — only in Settings (the menu says so and
 * keeps the filters).
 *
 * New chat came back here on 15.10 (Misha): 0.0.133 took the icon off the
 * header to give the account name room, and people lost the obvious way to
 * start a chat. Its tooltip names the person's own shortcut (chat.new).
 */
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  FolderIcon,
  FolderPlusIcon,
  LaptopIcon,
  ListFilterIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { create } from "zustand";

import { cn } from "../../lib/utils";
import {
  filterSidebarProjectScopeItems,
  reduceSidebarProjectScopeMenuState,
} from "../Sidebar.logic";
import { Checkbox } from "../ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SIDEBAR_D_HEADER_PRESETS,
  SIDEBAR_GROUP_LEVELS,
  headerPresetOf,
  levelsLabel,
  moveLevel,
  toggleFilter,
  toggleLevel,
  type SidebarGroupLevel,
} from "./sidebarDView.logic";

const BAR_BUTTON_CLASS =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-hidden hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-sidebar-row-hover data-popup-open:text-foreground";

/** "New chat ⌘N" — or plain "New chat" when nothing is bound. */
export function newChatTooltipLabel(shortcutLabel: string | null): string {
  return shortcutLabel ? `New chat ${shortcutLabel}` : "New chat";
}

/** The title's menu, open or not (the mock's "Show" buttons open it). */
export const useSidebarDViewMenu = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

/** Spreads the rest so it can also be a popup trigger's render target. */
function BarButton({
  label,
  tooltip,
  testId,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip: string;
  testId: string;
  children?: ReactNode;
} & Omit<ComponentProps<"button">, "children" | "aria-label">) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            data-testid={testId}
            {...rest}
            className={cn(BAR_BUTTON_CLASS, className)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Labs "Sidebar view menu" off — the 0.0.137 line: a quiet "Chats" label,
 * New chat, then Add a project. How the chats are laid out (classic or
 * inbox) is the Settings switch, not a control here (Misha 11.10).
 */
export function LegacySidebarDChatsBar(props: {
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

export interface SidebarDPickOption {
  readonly key: string;
  readonly label: string;
  /** A project's computer marks. */
  readonly adornment?: ReactNode;
  /** A computer's icon. */
  readonly icon?: ReactNode;
  /** A project's icon at a given size, for the funnel (the Projects submenu lists none). */
  readonly projectIcon?: (className: string) => ReactNode;
}

const LEVEL_ICON: Readonly<Record<SidebarGroupLevel, ReactNode>> = {
  project: <FolderIcon />,
  status: <CircleDashedIcon />,
  computer: <LaptopIcon />,
};

/** "Customize…": Misha's Group by — levels ticked in order, ↑↓ to reorder. */
function GroupLevels(props: {
  levels: ReadonlyArray<SidebarGroupLevel>;
  computerAvailable: boolean;
  onChange: (levels: ReadonlyArray<SidebarGroupLevel>) => void;
}) {
  const offered = SIDEBAR_GROUP_LEVELS.filter(
    (item) => item.id !== "computer" || props.computerAvailable,
  ).map((item) => item.id);
  const shown = props.levels.filter((level) => offered.includes(level));
  // Picked levels in their order, then the others.
  const rows = [...shown, ...offered.filter((id) => !shown.includes(id))];
  const arrowClass =
    "inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex flex-col p-1" data-testid="sidebar-d-group-levels">
      <p className="px-1.5 pb-1 text-xs text-muted-foreground">
        Group by, in this order — {levelsLabel(shown).toLowerCase()}
      </p>
      {rows.map((id) => {
        const on = shown.includes(id);
        const index = shown.indexOf(id);
        const name = SIDEBAR_GROUP_LEVELS.find((item) => item.id === id)!.name;
        return (
          <div
            key={id}
            className="flex h-7 items-center gap-1 rounded-sm pr-0.5 hover:bg-accent/60 [&_svg]:size-3.5 [&_svg]:shrink-0"
            data-testid={`sidebar-d-level-${id}`}
          >
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1.5 text-sm">
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
                  className={arrowClass}
                >
                  <ArrowUpIcon />
                </button>
                <button
                  type="button"
                  disabled={index === shown.length - 1}
                  onClick={() => props.onChange(moveLevel(shown, id, 1))}
                  aria-label={`Move ${name} down`}
                  className={arrowClass}
                >
                  <ArrowDownIcon />
                </button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Projects / Computers: a submenu of checkboxes, with a search when the list is long. */
function PickSubmenu(props: {
  label: string;
  allLabel: string;
  testId: string;
  options: ReadonlyArray<SidebarDPickOption>;
  picked: ReadonlyArray<string> | null;
  onChange: (picked: ReadonlyArray<string> | null) => void;
}) {
  const [query, setQuery] = useState("");
  const all = props.options.map((option) => option.key);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? props.options.filter((option) => option.label.toLowerCase().includes(needle))
    : props.options;
  return (
    <MenuSub>
      <MenuSubTrigger data-testid={`${props.testId}-trigger`}>
        <span className="flex-1">{props.label}</span>
        <span className="text-xs text-muted-foreground">
          {props.picked === null ? "All" : props.picked.length}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup className="w-56" data-testid={props.testId}>
        {props.options.length > 6 ? (
          <div className="flex items-center gap-1.5 px-2 pt-1 pb-1.5">
            <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              // The menu's type-to-jump must not eat the letters.
              onKeyDown={(event) => event.stopPropagation()}
              placeholder={`Find a ${props.label.toLowerCase().replace(/s$/, "")}`}
              aria-label={`Find ${props.label.toLowerCase()}`}
              className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </div>
        ) : null}
        <MenuCheckboxItem
          checked={props.picked === null}
          onCheckedChange={() => props.onChange(null)}
          data-testid={`${props.testId}-all`}
        >
          {props.allLabel}
        </MenuCheckboxItem>
        <MenuSeparator />
        <div className="max-h-64 overflow-y-auto">
          {shown.map((option) => (
            <MenuCheckboxItem
              key={option.key}
              checked={props.picked?.includes(option.key) ?? false}
              onCheckedChange={() => props.onChange(toggleFilter(props.picked, option.key, all))}
              data-testid={`${props.testId}-${option.label}`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {option.icon}
                <span className="truncate">{option.label}</span>
                {option.adornment}
              </span>
            </MenuCheckboxItem>
          ))}
        </div>
      </MenuSubPopup>
    </MenuSub>
  );
}

/** The funnel's first row; `filterSidebarProjectScopeItems` knows it by this value. */
const ALL_PROJECTS = "all";
/** One to three projects are read at a glance: the search stays out of sight. */
const FUNNEL_SEARCH_FROM = 4;

/**
 * The funnel: a row keeps only its project and closes, two clicks in all; the
 * tick at the row's end adds or takes away and stays open, on a phone too;
 * Shift+click and Shift+Enter do what the tick does. Held by the caller: the
 * same picks as the Projects submenu, changed by the same `toggleFilter`.
 */
function ProjectFilter(props: {
  options: ReadonlyArray<SidebarDPickOption>;
  picked: ReadonlyArray<string> | null;
  onChange: (picked: ReadonlyArray<string> | null) => void;
}) {
  const { options, picked, onChange } = props;
  const [menu, dispatchMenu] = useReducer(reduceSidebarProjectScopeMenuState, {
    open: false,
    query: "",
  });
  const highlightedRef = useRef<string | null>(null);
  const filter = useComboboxFilter();
  const items = useMemo(
    () => [
      { value: ALL_PROJECTS, label: "All projects" },
      ...options.map((option) => ({ value: option.key, label: option.label })),
    ],
    [options],
  );
  const filteredItems = useMemo(
    () =>
      filterSidebarProjectScopeItems({
        items,
        query: menu.query,
        matches: (item, query) => filter.contains(item, query, (candidate) => candidate.label),
      }),
    [filter, items, menu.query],
  );
  const shownPicks = options.filter((option) => picked?.includes(option.key));
  const toggle = (key: string) =>
    onChange(
      toggleFilter(
        picked,
        key,
        options.map((option) => option.key),
      ),
    );
  // Several picks are no single value: every row then answers to a click.
  const value =
    picked === null
      ? items[0]
      : picked.length === 1
        ? items.find((item) => item.value === picked[0])
        : undefined;
  const label =
    shownPicks.length > 0
      ? `Filter by project: ${shownPicks.map((option) => option.label).join(", ")}`
      : "Filter by project";
  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={menu.open}
      onOpenChange={(open, details) => {
        if (details.isCanceled) return;
        dispatchMenu({ type: "open-changed", open });
      }}
      onItemHighlighted={(item) => {
        highlightedRef.current = item?.value ?? null;
      }}
      value={value ?? null}
      onValueChange={(item, details) => {
        if (!item) return;
        if (item.value === ALL_PROJECTS) {
          onChange(null);
        } else if (details.event instanceof MouseEvent && details.event.shiftKey) {
          // Canceling skips Base UI's commit and its close.
          details.cancel();
          toggle(item.value);
        } else {
          onChange([item.value]);
        }
      }}
    >
      <ComboboxTrigger
        render={<BarButton label={label} tooltip={label} testId="sidebar-d-project-filter" />}
      >
        {shownPicks.length > 1 ? (
          <span className="flex shrink-0 -space-x-1.5" data-testid="sidebar-d-project-filter-icons">
            {shownPicks.slice(0, 2).map((option) => (
              // Monograms are see-through: each sits on the bar's own colour.
              <span
                key={option.key}
                className="flex shrink-0 rounded-[3px] bg-sidebar ring-1 ring-sidebar"
              >
                {option.projectIcon?.("size-3.5")}
              </span>
            ))}
          </span>
        ) : shownPicks[0] ? (
          <span className="flex shrink-0" data-testid="sidebar-d-project-filter-icons">
            {shownPicks[0].projectIcon?.("size-4")}
          </span>
        ) : (
          <ListFilterIcon className="size-3.5" data-testid="sidebar-d-project-filter-funnel" />
        )}
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        className="w-64 overflow-hidden"
        data-testid="sidebar-d-project-filter-popup"
      >
        {/* Out of sight, not gone: the keys go through this field. */}
        <div
          data-testid="sidebar-d-project-filter-search"
          className={options.length < FUNNEL_SEARCH_FROM ? "sr-only" : undefined}
        >
          <ComboboxSearchInput
            aria-label="Search projects"
            placeholder="Search projects"
            value={menu.query}
            onChange={(event) => dispatchMenu({ type: "query-changed", query: event.target.value })}
            onKeyDown={(event) => {
              // Base UI leaves Enter with Shift alone.
              if (event.key !== "Enter" || !event.shiftKey) return;
              if (event.nativeEvent.isComposing) return;
              const key = highlightedRef.current;
              if (key === null || key === ALL_PROJECTS) return;
              event.preventDefault();
              toggle(key);
            }}
          />
        </div>
        <ComboboxEmpty>No matching projects</ComboboxEmpty>
        <ComboboxList className="p-1" scrollAreaClassName="max-h-72" aria-multiselectable>
          {(item: (typeof items)[number]) => {
            const option = options.find((candidate) => candidate.key === item.value);
            const selected = option ? (picked?.includes(option.key) ?? false) : picked === null;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                value={item}
                aria-selected={selected}
                // The tick marks selection; Base UI's single value would shade one row.
                data-selected={undefined}
                data-testid={
                  option
                    ? `sidebar-d-project-filter-${option.label}`
                    : "sidebar-d-project-filter-all"
                }
                className="h-8 min-h-8 py-0 pe-1 max-sm:h-10"
                contentClassName="flex min-w-0 items-center gap-2"
              >
                {option?.projectIcon?.("size-4") ?? (
                  <FolderIcon className="size-4 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                {option?.adornment}
                {option ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`${selected ? "Remove" : "Add"} ${option.label}`}
                    aria-pressed={selected}
                    data-testid={`sidebar-d-project-filter-tick-${option.label}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(option.key);
                    }}
                    className={cn(
                      "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm max-sm:size-9",
                      selected
                        ? "text-foreground"
                        : "text-muted-foreground/35 hover:text-muted-foreground",
                    )}
                  >
                    <CheckIcon className="size-3.5" />
                  </button>
                ) : selected ? (
                  <span
                    aria-hidden
                    className="inline-flex size-6 shrink-0 items-center justify-center max-sm:size-9"
                  >
                    <CheckIcon className="size-3.5" />
                  </span>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

export function SidebarDChatsBar(props: {
  /** Which chats are shown: "All chats", "Chats · landing". */
  title: string;
  /** Grouping is picked in the title's menu (variant A); else only in Settings. */
  groupInHeader: boolean;
  /** The grouping as chosen (Computer kept even while only one computer is in view). */
  levels: ReadonlyArray<SidebarGroupLevel>;
  /** "By computer", Computer levels and the computer filter: only with 2+ computers. */
  multiComputer: boolean;
  onLevelsChange: (levels: ReadonlyArray<SidebarGroupLevel>) => void;
  /** Variant B: the menu's line that leads to the grouping in Settings. */
  onOpenSettings: () => void;
  /** Snoozed chats now; the menu leads to them while there are any. */
  snoozedCount: number;
  onShowSnoozed: () => void;
  onOpenArchive: () => void;
  projects: ReadonlyArray<SidebarDPickOption>;
  /** The funnel's list: the projects in view, with icons. One or none: no funnel. */
  filterProjects: ReadonlyArray<SidebarDPickOption>;
  pickedProjects: ReadonlyArray<string> | null;
  onProjectsChange: (picked: ReadonlyArray<string> | null) => void;
  computers: ReadonlyArray<SidebarDPickOption>;
  pickedComputers: ReadonlyArray<string> | null;
  onComputersChange: (picked: ReadonlyArray<string> | null) => void;
  /** Only the chats that are the person's now; off — every chat (the default). */
  onlyMine: boolean;
  onOnlyMineChange: (onlyMine: boolean) => void;
  onClearFilters: () => void;
  onNewChat: (event: ReactMouseEvent) => void;
  /** The person's chat.new shortcut (e.g. "⌘N"); null — none bound. */
  newChatShortcutLabel: string | null;
  onAddProject: () => void;
}) {
  const open = useSidebarDViewMenu((state) => state.open);
  const setOpen = useSidebarDViewMenu((state) => state.setOpen);
  const showComputers = props.multiComputer && props.computers.length > 1;
  const filtered =
    props.onlyMine || props.pickedProjects !== null || props.pickedComputers !== null;
  const levels = props.multiComputer
    ? props.levels
    : props.levels.filter((level) => level !== "computer");
  const preset = headerPresetOf(levels);
  return (
    <li
      className="mt-2 flex h-7 list-none items-center gap-0.5 pr-1 pl-1"
      data-testid="sidebar-d-chats-bar"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        <Menu open={open} onOpenChange={setOpen}>
          <MenuTrigger
            render={
              <button
                type="button"
                data-testid="sidebar-d-view-trigger"
                aria-label={`${props.title} — show and group chats`}
                className="group/view flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-md border border-transparent px-1.5 outline-hidden hover:border-border hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:border-border data-popup-open:bg-sidebar-row-hover"
              />
            }
          >
            <span className="min-w-0 truncate text-xs font-medium text-sidebar-foreground/90">
              {props.title}
            </span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </MenuTrigger>
          <MenuPopup
            align="start"
            side="bottom"
            sideOffset={4}
            className="w-56"
            data-testid="sidebar-d-view-menu"
          >
            {props.groupInHeader ? (
              <>
                <MenuRadioGroup
                  value={preset ?? "custom"}
                  onValueChange={(value) => {
                    const chosen = SIDEBAR_D_HEADER_PRESETS.find((item) => item.id === value);
                    if (chosen) props.onLevelsChange(chosen.levels);
                  }}
                >
                  {SIDEBAR_D_HEADER_PRESETS.filter(
                    (item) => item.id !== "computer" || props.multiComputer,
                  ).map((item) => (
                    <MenuRadioItem
                      key={item.id}
                      value={item.id}
                      closeOnClick
                      data-testid={`sidebar-d-preset-${item.id}`}
                    >
                      {item.label}
                    </MenuRadioItem>
                  ))}
                  {preset === null ? (
                    <MenuRadioItem value="custom" data-testid="sidebar-d-preset-custom">
                      <span className="truncate">{levelsLabel(levels)}</span>
                    </MenuRadioItem>
                  ) : null}
                </MenuRadioGroup>
                <MenuSub>
                  <MenuSubTrigger inset data-testid="sidebar-d-customize">
                    Customize…
                  </MenuSubTrigger>
                  <MenuSubPopup className="w-60">
                    <GroupLevels
                      levels={levels}
                      computerAvailable={props.multiComputer}
                      onChange={props.onLevelsChange}
                    />
                  </MenuSubPopup>
                </MenuSub>
              </>
            ) : (
              <MenuItem onClick={props.onOpenSettings} data-testid="sidebar-d-grouping-settings">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{levelsLabel(levels)}</span>
                  <span className="text-xs text-muted-foreground">Change in Settings</span>
                </span>
              </MenuItem>
            )}
            <MenuSeparator />
            {/* No hint under it (Misha 29.10: "don't litter"). */}
            <MenuCheckboxItem
              checked={props.onlyMine}
              onCheckedChange={(checked) => props.onOnlyMineChange(checked)}
              data-testid="sidebar-d-only-mine"
            >
              Only mine
            </MenuCheckboxItem>
            <PickSubmenu
              label="Projects"
              allLabel="All projects"
              testId="sidebar-d-pick-project"
              options={props.projects}
              picked={props.pickedProjects}
              onChange={props.onProjectsChange}
            />
            {showComputers ? (
              <PickSubmenu
                label="Computers"
                allLabel="All computers"
                testId="sidebar-d-pick-computer"
                options={props.computers}
                picked={props.pickedComputers}
                onChange={props.onComputersChange}
              />
            ) : null}
            <MenuSeparator />
            {props.snoozedCount > 0 ? (
              <MenuItem onClick={props.onShowSnoozed} data-testid="sidebar-d-show-snoozed">
                Snoozed ({props.snoozedCount})
              </MenuItem>
            ) : null}
            <MenuItem onClick={props.onOpenArchive} data-testid="sidebar-d-archived">
              Archived chats
            </MenuItem>
          </MenuPopup>
        </Menu>
        {props.filterProjects.length > 1 ? (
          <ProjectFilter
            options={props.filterProjects}
            picked={props.pickedProjects}
            onChange={props.onProjectsChange}
          />
        ) : null}
        {filtered ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={props.onClearFilters}
                  aria-label="Show all chats"
                  data-testid="sidebar-d-clear-filter"
                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground"
                />
              }
            >
              <XIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">Show all chats</TooltipPopup>
          </Tooltip>
        ) : null}
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
