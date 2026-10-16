/**
 * The right panel's row of tabs (w0138, point 4): shows which tabs live in
 * this chat and which are kept longer, and lets the person move them.
 *
 * Layout A (default, "pins"): pinned tabs on the left, icon only — first
 * "everywhere", then "project"; a thin divider; then this chat's tabs with
 * their names. On hover a tab shows a pin; the pin and a right-click open the
 * same menu: Keep in this chat / Pin to project <name> / Pin everywhere.
 * Dragging a tab across the divider pins it to the project (or back).
 *
 * Layout B ("project", like Codex): what is opened belongs to the project;
 * only "everywhere" tabs are icon pins.
 *
 * Tabs the agent opened carry a small robot mark.
 */
import { BotIcon, PinIcon, XIcon } from "lucide-react";
import { Fragment, useState } from "react";

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
import {
  DUAL_VIEW_KINDS,
  isTasksTab,
  type PreviewFile,
  type PreviewFileKind,
  usePreviewPane,
} from "./PreviewPaneContext";
import {
  scopeChoiceLabel,
  scopeForDrop,
  scopeHint,
  splitStripTabs,
  type PanelTabsLayout,
} from "./panelTabs.logic";
import { PREVIEW_TAB_SCOPES, type PreviewTabScope } from "./previewTabScopes";
import { TasksTabName } from "./TasksTabBody";

type KindIcon = React.ComponentType<{ className?: string }>;

const DRAG_TYPE = "application/x-uno-panel-tab";

/** A point on the screen as an anchor for the menu (right-click). */
function pointAnchor(x: number, y: number) {
  return {
    getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }),
  };
}

type MenuState = {
  readonly file: PreviewFile;
  readonly anchor: Element | ReturnType<typeof pointAnchor>;
} | null;

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

  const openMenuAtPointer = (file: PreviewFile) => (event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ file, anchor: pointAnchor(event.clientX, event.clientY) });
  };

  const tooltip = (file: PreviewFile) => {
    if (isTasksTab(file)) return "Tasks and plan of this chat";
    const lines = [`${kindLabel[file.kind]} — ${file.name}`, scopeHint(scopeOf(file), projectName)];
    if (file.openedBy === "agent") lines.push("Opened by the agent");
    if (DUAL_VIEW_KINDS.has(file.kind)) lines.push("Double-click: code ↔ preview");
    if (movable(file)) lines.push("Right-click to pin or move");
    return lines.join("\n");
  };

  const agentMark = (file: PreviewFile) =>
    file.openedBy === "agent" ? (
      <BotIcon
        aria-label="Opened by the agent"
        className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-card text-muted-foreground"
      />
    ) : null;

  // Pins sit before the divider; while a chat tab is dragged and there are no
  // pins yet, an empty slot shows where to drop it.
  const showPinSlot =
    layout === "pins" && pinned.length === 0 && dragging !== null && dragging.scope === "chat";
  const showDivider = (pinned.length > 0 || showPinSlot) && named.length > 0;

  return (
    <>
      {/* Pins stay in view while the chat's tabs scroll under them, like a browser. */}
      {pinned.length > 0 || showPinSlot ? (
        <div className="sticky left-0 z-10 -ml-2 flex shrink-0 items-center bg-card pl-2">
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
                  {groupBreak ? (
                    <span aria-hidden className="mx-px h-2.5 w-px bg-border/70" />
                  ) : null}
                  <button
                    type="button"
                    data-preview-tab={file.id}
                    data-tab-scope={scope}
                    {...dragSource(file)}
                    onClick={() => onSelect(file.id)}
                    onDoubleClick={() => {
                      if (DUAL_VIEW_KINDS.has(file.kind)) toggleSourceView(file.id);
                    }}
                    onContextMenu={openMenuAtPointer(file)}
                    aria-label={`${file.name} (${scopeHint(scope, projectName)})`}
                    title={tooltip(file)}
                    className={cn(
                      "relative inline-flex size-7 shrink-0 items-center justify-center rounded-md",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      dragging?.id === file.id && "opacity-40",
                    )}
                  >
                    <span className="relative inline-flex">
                      <Icon className="size-3.5" />
                      {agentMark(file)}
                    </span>
                  </button>
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
          {showDivider ? (
            <span
              aria-hidden
              className="mx-1 h-4 w-px shrink-0 bg-border"
              data-testid="panel-tabs-divider"
            />
          ) : null}
        </div>
      ) : null}
      <div
        {...dropTarget("named")}
        className={cn(
          "flex min-w-0 shrink-0 items-center gap-1 rounded-md transition-colors",
          dropZone === "named" && "bg-accent/60",
        )}
      >
        {named.map((file) => {
          const Icon = kindIcon[file.kind];
          const scope = scopeOf(file);
          const isActive = file.id === activeId;
          const canPin = layout === "pins" && movable(file);
          return (
            <div
              key={file.id}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
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
              onContextMenu={openMenuAtPointer(file)}
              title={tooltip(file)}
              className={cn(
                "group relative inline-flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-md pr-1 pl-2 text-xs outline-none select-none focus-visible:ring-1 focus-visible:ring-ring",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
                dragging?.id === file.id && "opacity-40",
              )}
            >
              <span className="relative inline-flex shrink-0">
                <Icon className="size-3.5" />
                {agentMark(file)}
              </span>
              <span className="max-w-[8rem] truncate">
                {isTasksTab(file) ? <TasksTabName file={file} /> : file.name}
              </span>
              {canPin ? (
                <button
                  type="button"
                  aria-label="Pin this tab"
                  title="Pin: keep it for the project or everywhere"
                  data-testid="panel-tab-pin"
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenu({ file, anchor: event.currentTarget });
                  }}
                  className={cn(
                    "-mr-0.5 inline-flex size-4 items-center justify-center rounded opacity-0 hover:bg-background/60 hover:opacity-100 group-hover:opacity-60 focus-visible:opacity-100",
                    menu?.file.id === file.id && "opacity-100",
                  )}
                >
                  <PinIcon className="size-3" />
                </button>
              ) : null}
              <button
                type="button"
                aria-label={`Close ${file.name}`}
                className="inline-flex size-4 items-center justify-center rounded opacity-60 hover:bg-background/60 hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  closeFile(file.id);
                }}
              >
                <XIcon className="size-3" />
              </button>
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
    </>
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
  // Order of the choices: from "only here" to "everywhere".
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
        className="w-60"
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
        {movable && layout === "pins" ? (
          <div className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">
            Tip: drag a tab left of the line to pin it to the project.
          </div>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
