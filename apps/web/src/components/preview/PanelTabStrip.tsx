/**
 * The right panel's row of tabs (w0138, point 4): shows which tabs live in
 * this chat and which are kept longer, and lets the person move them.
 *
 * Layout A (default, "pins"): pinned tabs on the left — icons with a tooltip
 * (the open one shows its short name), first "every chat", then "project";
 * a divider; then this chat's tabs. On
 * hover a tab shows a pin; the pin and a right-click open the same menu under
 * the tab: Keep in this chat / Pin to project <name> / Show in every chat.
 * Dragging a tab across the divider pins it to the project (or back).
 *
 * Layout B ("project", like Codex): what is opened belongs to the project;
 * only "every chat" tabs are pins.
 *
 * Named tabs size like Chrome (`fitStripTabs`): 180 → 72 px, then inactive
 * tabs fold into icons and the active one stays named and in view; past that
 * the row scrolls with a fade at the edge. Tabs the agent opened carry a
 * small robot mark.
 */
import { BotIcon, PinIcon, XIcon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

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
  fitStripTabs,
  pinLabel,
  scopeChoiceLabel,
  scopeForDrop,
  scopeHint,
  splitStripTabs,
  TAB_MAX_WIDTH,
  TAB_MIN_WIDTH,
  type PanelTabsLayout,
  type StripFit,
} from "./panelTabs.logic";
import { PREVIEW_TAB_SCOPES, type PreviewTabScope } from "./previewTabScopes";
import { TasksTabName } from "./TasksTabBody";

type KindIcon = React.ComponentType<{ className?: string }>;

const DRAG_TYPE = "application/x-uno-panel-tab";
/** Room kept after the tabs for the "+" (and the "New tab" chip while it shows). */
const TRAILING_RESERVE = 36;

type MenuState = { readonly file: PreviewFile; readonly anchor: Element } | null;

function AgentMark({ file }: { file: PreviewFile }) {
  if (file.openedBy !== "agent") return null;
  return (
    <BotIcon
      aria-label="Opened by the agent"
      className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-card text-muted-foreground"
    />
  );
}

/** Space for the named tabs and whether the row is scrolled away from either edge. */
function useStripLayout(count: number, activeId: string | null) {
  const pinnedRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<StripFit>("names");
  const [edges, setEdges] = useState({ left: false, right: false });

  const measureEdges = () => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    // The row's own box (PreviewPane's strip): its width is what the header
    // leaves, whatever the tabs need.
    const row = scroller?.parentElement;
    if (!scroller || !row) return;
    const measure = () => {
      const pinned = pinnedRef.current?.offsetWidth ?? 0;
      const available = row.clientWidth - pinned - TRAILING_RESERVE;
      setFit(fitStripTabs(available, count));
      measureEdges();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    if (pinnedRef.current) observer.observe(pinnedRef.current);
    return () => observer.disconnect();
  }, [count]);

  // The active tab is always fully in view.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !activeId) return;
    const el = scroller.querySelector(`[data-preview-tab="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
    measureEdges();
  }, [activeId, fit, count]);

  return { pinnedRef, scrollRef, fit, edges, measureEdges };
}

export function PanelTabStrip({
  files,
  activeId,
  layout,
  projectName,
  kindIcon,
  kindLabel,
  onSelect,
}: {
  files: ReadonlyArray<PreviewFile>;
  activeId: string | null;
  layout: PanelTabsLayout;
  projectName: string | null;
  kindIcon: Record<PreviewFileKind, KindIcon>;
  kindLabel: Record<PreviewFileKind, string>;
  onSelect: (id: string) => void;
}) {
  const { tabScopeById, setTabScope, closeFile, toggleSourceView, currentChatThreadId } =
    usePreviewPane();
  const [menu, setMenu] = useState<MenuState>(null);
  const [dragging, setDragging] = useState<{ id: string; scope: PreviewTabScope } | null>(null);
  const [dropZone, setDropZone] = useState<"pinned" | "named" | null>(null);

  const { pinned, named } = splitStripTabs(files, tabScopeById, layout);
  const { pinnedRef, scrollRef, fit, edges, measureEdges } = useStripLayout(named.length, activeId);
  const inChat = currentChatThreadId !== null;
  const scopeOf = (file: PreviewFile): PreviewTabScope => tabScopeById[file.id] ?? "chat";
  const movable = (file: PreviewFile) => inChat && !isTasksTab(file);

  const dropTarget = (zone: "pinned" | "named") => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragging || !scopeForDrop(zone, dragging.scope, layout)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dropZone !== zone) setDropZone(zone);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setDropZone((current) => (current === zone ? null : current));
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer.getData(DRAG_TYPE);
      const file = files.find((candidate) => candidate.id === id);
      setDropZone(null);
      setDragging(null);
      if (!file) return;
      const next = scopeForDrop(zone, scopeOf(file), layout);
      if (next) setTabScope(file.id, next);
    },
  });

  const dragSource = (file: PreviewFile) =>
    movable(file)
      ? {
          draggable: true,
          onDragStart: (event: React.DragEvent) => {
            event.dataTransfer.setData(DRAG_TYPE, file.id);
            event.dataTransfer.effectAllowed = "move";
            setDragging({ id: file.id, scope: scopeOf(file) });
          },
          onDragEnd: () => {
            setDragging(null);
            setDropZone(null);
          },
        }
      : {};

  /** Menus open under the tab, not over the row. */
  const openMenuUnderTab = (file: PreviewFile, from: Element) => {
    const tab = from.closest("[data-preview-tab]") ?? from;
    setMenu({ file, anchor: tab });
  };

  const tooltip = (file: PreviewFile) => {
    if (isTasksTab(file)) return "Tasks and plan of this chat";
    const lines = [`${kindLabel[file.kind]} — ${file.name}`, scopeHint(scopeOf(file), projectName)];
    if (file.openedBy === "agent") lines.push("Opened by the agent");
    if (DUAL_VIEW_KINDS.has(file.kind)) lines.push("Double-click: code ↔ preview");
    return lines.join("\n");
  };

  // While a chat tab is dragged and there are no pins yet, an empty slot shows where to drop it.
  const showPinSlot =
    layout === "pins" && pinned.length === 0 && dragging !== null && dragging.scope === "chat";
  const showPins = pinned.length > 0 || showPinSlot;
  const fade = `linear-gradient(to right, ${edges.left ? "transparent, black 24px" : "black"}, ${
    edges.right ? "black calc(100% - 24px), transparent" : "black"
  })`;

  return (
    <TooltipProvider delay={300} closeDelay={0}>
      {showPins ? (
        <div ref={pinnedRef} className="flex shrink-0 items-center">
          <div
            {...dropTarget("pinned")}
            data-testid="panel-pinned-tabs"
            className={cn(
              "flex shrink-0 items-center gap-0.5 rounded-md transition-colors",
              dropZone === "pinned" && "bg-primary/10 ring-1 ring-primary/40",
            )}
          >
            {pinned.map((file, index) => {
              const Icon = kindIcon[file.kind];
              const scope = scopeOf(file);
              const isActive = file.id === activeId;
              const groupBreak = index > 0 && scopeOf(pinned[index - 1]!) !== scope;
              return (
                <Fragment key={file.id}>
                  {groupBreak ? <span aria-hidden className="mx-0.5 h-3 w-px bg-border" /> : null}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-preview-tab={file.id}
                          data-tab-scope={scope}
                          {...dragSource(file)}
                          onClick={() => onSelect(file.id)}
                          onDoubleClick={() => {
                            if (DUAL_VIEW_KINDS.has(file.kind)) toggleSourceView(file.id);
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            openMenuUnderTab(file, event.currentTarget);
                          }}
                          aria-label={`${file.name} (${scopeHint(scope, projectName)})`}
                          className={cn(
                            "relative inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[11px]",
                            isActive
                              ? "bg-accent text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            dragging?.id === file.id && "opacity-40",
                          )}
                        />
                      }
                    >
                      <span className="relative inline-flex shrink-0">
                        <Icon className="size-3.5" />
                        <AgentMark file={file} />
                      </span>
                      {/* Pins are icons with a tooltip; the open one says its short name. */}
                      {isActive ? (
                        <span className="max-w-[4.5rem] truncate">{pinLabel(file)}</span>
                      ) : null}
                    </TooltipTrigger>
                    <TooltipPopup side="bottom" className="whitespace-pre-line">
                      {tooltip(file)}
                    </TooltipPopup>
                  </Tooltip>
                </Fragment>
              );
            })}
            {showPinSlot ? (
              <span className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-primary/50 px-2 text-[11px] text-primary">
                <PinIcon className="size-3" />
                Pin to project
              </span>
            ) : null}
          </div>
          {named.length > 0 ? (
            <span
              aria-hidden
              className="mx-1.5 h-5 w-px shrink-0 bg-foreground/25"
              data-testid="panel-tabs-divider"
            />
          ) : null}
        </div>
      ) : null}
      <div
        ref={scrollRef}
        {...dropTarget("named")}
        onScroll={measureEdges}
        style={edges.left || edges.right ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
        className={cn(
          "scrollbar-hide flex min-w-0 shrink items-center gap-1 overflow-x-auto rounded-md transition-colors",
          dropZone === "named" && "bg-accent/60",
        )}
      >
        {named.map((file) => {
          const Icon = kindIcon[file.kind];
          const scope = scopeOf(file);
          const isActive = file.id === activeId;
          const canPin = layout === "pins" && movable(file);
          const folded = fit === "icons" && !isActive;
          return (
            <div
              key={file.id}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              aria-label={file.name}
              data-preview-tab={file.id}
              data-tab-scope={scope}
              {...dragSource(file)}
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
                folded
                  ? undefined
                  : fit === "icons"
                    ? // Folded row: the open tab keeps its whole name (up to the max).
                      { flex: "0 0 auto", maxWidth: TAB_MAX_WIDTH }
                    : { flex: `0 1 ${TAB_MAX_WIDTH}px`, minWidth: TAB_MIN_WIDTH }
              }
              className={cn(
                "group relative inline-flex h-7 cursor-default items-center rounded-md text-xs outline-none select-none focus-visible:ring-1 focus-visible:ring-ring",
                folded ? "w-7 shrink-0 justify-center" : "gap-1.5 pr-1 pl-2",
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
              {folded ? null : (
                <>
                  <span className="min-w-0 flex-1 truncate">
                    {isTasksTab(file) ? <TasksTabName file={file} /> : file.name}
                  </span>
                  {canPin ? (
                    <button
                      type="button"
                      aria-label="Pin this tab"
                      title={
                        "Pin: keep it for the project or show it in every chat.\nOr drag the tab left of the line."
                      }
                      data-testid="panel-tab-pin"
                      onClick={(event) => {
                        event.stopPropagation();
                        openMenuUnderTab(file, event.currentTarget);
                      }}
                      className={cn(
                        "-mr-0.5 size-4 shrink-0 items-center justify-center rounded opacity-60 hover:bg-background/60 hover:opacity-100",
                        menu?.file.id === file.id
                          ? "inline-flex"
                          : "hidden group-hover:inline-flex",
                      )}
                    >
                      <PinIcon className="size-3" />
                    </button>
                  ) : null}
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
          );
        })}
      </div>
      <TabScopeMenu
        menu={menu}
        onClose={() => setMenu(null)}
        scope={menu ? scopeOf(menu.file) : "chat"}
        movable={menu ? movable(menu.file) : false}
        layout={layout}
        projectName={projectName}
        onScope={(scope) => {
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

function TabScopeMenu({
  menu,
  onClose,
  scope,
  movable,
  layout,
  projectName,
  onScope,
  onCloseTab,
}: {
  menu: MenuState;
  onClose: () => void;
  scope: PreviewTabScope;
  movable: boolean;
  layout: PanelTabsLayout;
  projectName: string | null;
  onScope: (scope: PreviewTabScope) => void;
  onCloseTab: () => void;
}) {
  // Order of the choices: from "only here" to "every chat".
  const choices = PREVIEW_TAB_SCOPES.toReversed();
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
        data-testid="panel-tab-scope-menu"
      >
        <MenuGroup>
          <MenuGroupLabel className="truncate">{menu?.file.name}</MenuGroupLabel>
          {movable ? (
            <MenuRadioGroup
              value={scope}
              onValueChange={(value) => onScope(value as PreviewTabScope)}
            >
              {choices.map((choice) => (
                <MenuRadioItem key={choice} value={choice}>
                  {scopeChoiceLabel(choice, projectName, layout)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          ) : null}
        </MenuGroup>
        {movable ? <MenuSeparator /> : null}
        <MenuItem onClick={onCloseTab}>Close tab</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
