/**
 * The right panel's row of tabs (w0138, point 4; Misha 16.10): up to three
 * outlined groups, like tab groups in Chrome — This chat → Project →
 * Everywhere, left to right (the wider the group, the further right). Each
 * group starts with its label — a small icon (bubble / folder / globe) or its
 * name; a click on the label collapses the group into it, like Chrome (the open
 * tab stays in view). An empty group isn't drawn. Switching to another chat
 * of the same project keeps Everywhere and Project as they are — only the
 * chat's group changes.
 *
 * Dragging, like Chrome: a tab dragged along its group changes places, into
 * another outline moves there (a line shows where it lands; while dragging,
 * missing groups show as empty slots). Right-click → Move to is the fallback.
 * Tabs size like Chrome (`foldedGroups`): 180 → 72 px, then inactive tabs
 * fold into icons — the chat's group first; the active tab keeps its name and
 * stays in view; past that the row scrolls with a fade at the edge. Tabs the
 * agent opened carry a small robot mark.
 */
import { BotIcon, FolderIcon, GlobeIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useDemoSwitch } from "../../demo/demoFlag";
import { cn } from "../../lib/utils";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  DUAL_VIEW_KINDS,
  isTasksTab,
  type PreviewFile,
  type PreviewFileKind,
  usePreviewPane,
} from "./PreviewPaneContext";
import {
  foldedGroups,
  GROUP_LABEL,
  GROUP_ORDER,
  groupLabelWidth,
  groupStripTabs,
  moveToLabel,
  scopeHint,
  TAB_MAX_WIDTH,
  TAB_MIN_WIDTH,
  tabsShownInGroup,
} from "./panelTabs.logic";
import type { PreviewTabScope } from "./previewTabScopes";
import { TasksTabName } from "./TasksTabBody";

type KindIcon = React.ComponentType<{ className?: string }>;

const DRAG_TYPE = "application/x-uno-panel-tab";
/** Room kept after the groups for the "+" button. */
const TRAILING_RESERVE = 36;
/** Groups the person collapsed (by their label), kept across chats and reloads. */
const COLLAPSED_KEY = "uno:panel-collapsed-tab-groups";

function readCollapsed(): ReadonlyArray<PreviewTabScope> {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return Array.isArray(value)
      ? GROUP_ORDER.filter((scope) => (value as unknown[]).includes(scope))
      : [];
  } catch {
    return [];
  }
}

const GROUP_ICON: Record<PreviewTabScope, KindIcon> = {
  global: GlobeIcon,
  project: FolderIcon,
  chat: MessageSquareIcon,
};

/** A faint tint per group, so the three read apart at a glance (like Chrome's group colors). */
const GROUP_TINT: Record<PreviewTabScope, string> = {
  global: "border-sky-500/35",
  project: "border-violet-500/35",
  chat: "border-border",
};
const LABEL_TINT: Record<PreviewTabScope, string> = {
  global: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  project: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  chat: "bg-muted text-muted-foreground",
};

function groupTitle(scope: PreviewTabScope, projectName: string | null): string {
  switch (scope) {
    case "global":
      return "Everywhere — shown in every chat and screen";
    case "project":
      return `${projectName ? `Project ${projectName}` : "Project"} — stays when you switch between its chats`;
    case "chat":
      return "This chat — only here";
  }
}

type MenuState = { readonly file: PreviewFile; readonly anchor: Element } | null;
/** Where a dragged tab would land: before `beforeId` of `scope`, or at its end. */
type DropSpot = { readonly scope: PreviewTabScope; readonly beforeId: string | null } | null;

function DropLine() {
  return <span aria-hidden className="h-5 w-0.5 shrink-0 rounded-full bg-primary" />;
}

function AgentMark({ file }: { file: PreviewFile }) {
  if (file.openedBy !== "agent") return null;
  return (
    <BotIcon
      aria-label="Opened by the agent"
      className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-card text-muted-foreground"
    />
  );
}

export function PanelTabStrip({
  files,
  activeId,
  projectName,
  kindIcon,
  kindLabel,
  onSelect,
}: {
  files: ReadonlyArray<PreviewFile>;
  activeId: string | null;
  projectName: string | null;
  kindIcon: Record<PreviewFileKind, KindIcon>;
  kindLabel: Record<PreviewFileKind, string>;
  onSelect: (id: string) => void;
}) {
  const { tabScopeById, setTabScope, closeFile, toggleSourceView, currentChatThreadId } =
    usePreviewPane();
  const withIcons = useDemoSwitch("tabGroupIcons") === "icon";
  const [menu, setMenu] = useState<MenuState>(null);
  const [dragging, setDragging] = useState<{ id: string; scope: PreviewTabScope } | null>(null);
  const [drop, setDrop] = useState<DropSpot>(null);
  const [collapsed, setCollapsed] = useState<ReadonlyArray<PreviewTabScope>>(readCollapsed);
  const toggleCollapsed = (scope: PreviewTabScope) => {
    const next = collapsed.includes(scope)
      ? collapsed.filter((item) => item !== scope)
      : [...collapsed, scope];
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    } catch {
      // private mode: collapsed for this session only
    }
  };
  const inChat = currentChatThreadId !== null;
  const scopeOf = (file: PreviewFile): PreviewTabScope => tabScopeById[file.id] ?? "chat";
  const movable = (file: PreviewFile) => inChat && !isTasksTab(file);

  const groups = useMemo(() => groupStripTabs(files, tabScopeById), [files, tabScopeById]);
  const activeScope = activeId ? (tabScopeById[activeId] ?? "chat") : null;
  const shownIn = (scope: PreviewTabScope, groupFiles: ReadonlyArray<PreviewFile>) =>
    tabsShownInGroup(groupFiles, collapsed.includes(scope), activeId);

  // ── Fit: which groups show inactive tabs as icons ──
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(Number.POSITIVE_INFINITY);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measureEdges = () => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };
  useLayoutEffect(() => {
    // PreviewPane's row: its width is what the header leaves, whatever the tabs need.
    const row = scrollRef.current?.parentElement;
    if (!row) return;
    const measure = () => {
      setAvailable(row.clientWidth - TRAILING_RESERVE);
      measureEdges();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const folded = useMemo(
    () =>
      foldedGroups({
        available,
        groups: groups.map((group) => {
          const count = shownIn(group.scope, group.files).length;
          return {
            scope: group.scope,
            count,
            active: group.scope === activeScope,
            labelWidth: groupLabelWidth(group.scope, withIcons, group.files.length - count),
          };
        }),
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- shownIn reads collapsed/activeId
    [available, withIcons, groups, activeScope, collapsed, activeId],
  );
  // The active tab is always fully in view.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !activeId) return;
    scroller
      .querySelector(`[data-preview-tab="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    measureEdges();
  }, [activeId, folded, files.length]);

  // ── Dragging, like Chrome: along the group to reorder, into another outline to move ──
  const finishDrag = () => {
    setDragging(null);
    setDrop(null);
  };
  const aim = (spot: NonNullable<DropSpot>) => {
    if (drop?.scope !== spot.scope || drop.beforeId !== spot.beforeId) setDrop(spot);
  };
  const dropTarget = (scope: PreviewTabScope) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragging) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      // Over the outline but not over a tab: the end of the group.
      if (!(event.target as Element).closest?.("[data-preview-tab]"))
        aim({ scope, beforeId: null });
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDrop((current) => (current?.scope === scope ? null : current));
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer.getData(DRAG_TYPE);
      const spot = drop ?? { scope, beforeId: null };
      finishDrag();
      if (id) setTabScope(id, spot.scope, spot.beforeId);
    },
  });
  /** Over a tab: before it when on its left half, else before the next one of the group. */
  const aimAtTab = (
    event: React.DragEvent,
    scope: PreviewTabScope,
    groupFiles: ReadonlyArray<PreviewFile>,
    file: PreviewFile,
  ) => {
    if (!dragging) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const index = groupFiles.findIndex((item) => item.id === file.id);
    const before =
      event.clientX < rect.left + rect.width / 2 ? file : (groupFiles[index + 1] ?? null);
    aim({ scope, beforeId: before?.id ?? null });
  };
  const dragSource = (file: PreviewFile) =>
    movable(file)
      ? {
          draggable: true,
          onDragStart: (event: React.DragEvent) => {
            event.dataTransfer.setData(DRAG_TYPE, file.id);
            event.dataTransfer.effectAllowed = "move";
            setDragging({ id: file.id, scope: scopeOf(file) });
          },
          onDragEnd: finishDrag,
        }
      : {};
  const openMenuUnderTab = (file: PreviewFile, from: Element) => {
    setMenu({ file, anchor: from.closest("[data-preview-tab]") ?? from });
  };

  const tooltip = (file: PreviewFile) => {
    if (isTasksTab(file)) return "Tasks and plan of this chat";
    const lines = [`${kindLabel[file.kind]} — ${file.name}`, scopeHint(scopeOf(file), projectName)];
    if (file.openedBy === "agent") lines.push("Opened by the agent");
    if (DUAL_VIEW_KINDS.has(file.kind)) lines.push("Double-click: code ↔ preview");
    if (movable(file)) lines.push("Drag to reorder or into another group · right-click → Move to");
    return lines.join("\n");
  };

  // While a tab is dragged in a chat, every group it could go to shows — empty ones as slots.
  const shown: ReadonlyArray<{ scope: PreviewTabScope; files: ReadonlyArray<PreviewFile> }> =
    dragging && inChat
      ? GROUP_ORDER.map(
          (scope) => groups.find((group) => group.scope === scope) ?? { scope, files: [] },
        )
      : groups;
  const fade = `linear-gradient(to right, ${edges.left ? "transparent, black 24px" : "black"}, ${
    edges.right ? "black calc(100% - 24px), transparent" : "black"
  })`;

  return (
    <TooltipProvider delay={300} closeDelay={0}>
      <div
        ref={scrollRef}
        onScroll={measureEdges}
        style={edges.left || edges.right ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
        className="scrollbar-hide flex min-w-0 shrink items-center gap-1.5 overflow-x-auto"
        data-testid="panel-tab-groups"
      >
        {shown.map(({ scope, files: groupFiles }) => {
          const GroupIcon = GROUP_ICON[scope];
          const fold = folded.includes(scope);
          const isCollapsed = collapsed.includes(scope) && groupFiles.length > 0;
          const visible = shownIn(scope, groupFiles);
          const hidden = groupFiles.length - visible.length;
          const lineAt = (beforeId: string | null) =>
            drop?.scope === scope && drop.beforeId === beforeId ? <DropLine /> : null;
          return (
            <div
              key={scope}
              {...dropTarget(scope)}
              data-tab-group={scope}
              data-collapsed={isCollapsed || undefined}
              className={cn(
                "flex h-7.5 items-center gap-0.5 rounded-lg border p-0.5 transition-colors",
                GROUP_TINT[scope],
                groupFiles.length === 0 && "border-dashed pr-2",
                drop?.scope === scope && "border-primary bg-primary/5",
              )}
              style={{ flex: "0 1 auto" }}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${GROUP_LABEL[scope]}${isCollapsed ? ` — ${hidden} hidden` : ""}`}
                      aria-expanded={groupFiles.length > 0 ? !isCollapsed : undefined}
                      data-testid={`panel-tab-group-label-${scope}`}
                      disabled={groupFiles.length === 0}
                      onClick={() => toggleCollapsed(scope)}
                      className={cn(
                        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md text-[11px] font-medium whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default",
                        withIcons ? "min-w-5 justify-center px-1" : "px-1.5",
                        groupFiles.length === 0 ? "text-muted-foreground" : LABEL_TINT[scope],
                        groupFiles.length > 0 && "cursor-pointer hover:brightness-95",
                      )}
                    />
                  }
                >
                  {withIcons ? <GroupIcon className="size-3" /> : null}
                  {!withIcons || groupFiles.length === 0
                    ? scope === "project" && projectName && groupFiles.length === 0
                      ? `Project · ${projectName}`
                      : GROUP_LABEL[scope]
                    : null}
                  {isCollapsed && hidden > 0 ? (
                    <span className="tabular-nums opacity-80">{hidden}</span>
                  ) : null}
                </TooltipTrigger>
                <TooltipPopup side="bottom" className="whitespace-pre-line">
                  {groupTitle(scope, projectName)}
                  {groupFiles.length > 0
                    ? isCollapsed
                      ? "\nClick to show its tabs"
                      : "\nClick to collapse"
                    : ""}
                </TooltipPopup>
              </Tooltip>
              {visible.map((file) => {
                const Icon = kindIcon[file.kind];
                const isActive = file.id === activeId;
                const iconOnly = fold && !isActive;
                return (
                  <Fragment key={file.id}>
                    {lineAt(file.id)}
                    <div
                      role="tab"
                      tabIndex={0}
                      aria-selected={isActive}
                      aria-label={file.name}
                      data-preview-tab={file.id}
                      data-tab-scope={scope}
                      {...dragSource(file)}
                      onDragOver={(event) => aimAtTab(event, scope, groupFiles, file)}
                      onClick={() => onSelect(file.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelect(file.id);
                        }
                      }}
                      onDoubleClick={() => {
                        if (DUAL_VIEW_KINDS.has(file.kind)) toggleSourceView(file.id);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openMenuUnderTab(file, event.currentTarget);
                      }}
                      title={tooltip(file)}
                      style={
                        iconOnly
                          ? undefined
                          : fold
                            ? // In a folded group the open tab keeps its whole name.
                              { flex: "0 0 auto", maxWidth: TAB_MAX_WIDTH }
                            : // As wide as the name (up to 180), shrinking to 72 when the row is tight.
                              { flex: "0 1 auto", minWidth: TAB_MIN_WIDTH, maxWidth: TAB_MAX_WIDTH }
                      }
                      className={cn(
                        "group relative inline-flex h-6 cursor-default items-center rounded-md text-xs outline-none select-none focus-visible:ring-1 focus-visible:ring-ring",
                        iconOnly ? "w-6 shrink-0 justify-center" : "gap-1.5 pr-1 pl-1.5",
                        isActive
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50",
                        dragging?.id === file.id && "opacity-40",
                      )}
                    >
                      <span className="relative inline-flex shrink-0">
                        <Icon className="size-3.5" />
                        <AgentMark file={file} />
                      </span>
                      {iconOnly ? null : (
                        <>
                          <span className="min-w-0 flex-1 truncate">
                            {isTasksTab(file) ? <TasksTabName file={file} /> : file.name}
                          </span>
                          <button
                            type="button"
                            aria-label={`Close ${file.name}`}
                            className={cn(
                              "size-4 shrink-0 items-center justify-center rounded opacity-60 hover:bg-background/60 hover:opacity-100",
                              isActive ? "inline-flex" : "hidden group-hover:inline-flex",
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              closeFile(file.id);
                            }}
                          >
                            <XIcon className="size-3" />
                          </button>
                        </>
                      )}
                    </div>
                  </Fragment>
                );
              })}
              {lineAt(null)}
            </div>
          );
        })}
      </div>
      <TabMoveMenu
        menu={menu}
        onClose={() => setMenu(null)}
        scope={menu ? scopeOf(menu.file) : "chat"}
        movable={menu ? movable(menu.file) : false}
        projectName={projectName}
        onMove={(scope) => {
          if (menu) setTabScope(menu.file.id, scope);
          setMenu(null);
        }}
        onCloseTab={() => {
          if (menu) closeFile(menu.file.id);
          setMenu(null);
        }}
      />
    </TooltipProvider>
  );
}

function TabMoveMenu({
  menu,
  onClose,
  scope,
  movable,
  projectName,
  onMove,
  onCloseTab,
}: {
  menu: MenuState;
  onClose: () => void;
  scope: PreviewTabScope;
  movable: boolean;
  projectName: string | null;
  onMove: (scope: PreviewTabScope) => void;
  onCloseTab: () => void;
}) {
  return (
    <Menu
      open={menu !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPopup
        anchor={menu?.anchor}
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-56"
        data-testid="panel-tab-move-menu"
      >
        {movable ? (
          <MenuGroup>
            <MenuGroupLabel>Move to</MenuGroupLabel>
            <MenuRadioGroup
              value={scope}
              onValueChange={(value) => onMove(value as PreviewTabScope)}
            >
              {GROUP_ORDER.map((choice) => (
                <MenuRadioItem key={choice} value={choice}>
                  {moveToLabel(choice, projectName)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {movable ? <MenuSeparator /> : null}
        <MenuItem onClick={onCloseTab}>Close tab</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
