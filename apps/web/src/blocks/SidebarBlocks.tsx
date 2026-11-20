/**
 * The sidebar's blocks (T55 demo, 20.11): the new built-in blocks (Computers,
 * Projects, Running apps), an app's widget as a block, and the edit mode —
 * each block in a frame with a grip, its name, a size for widgets and ×; on
 * top the presets, at the bottom "Add block", which opens the catalog.
 *
 * The blocks that existed before (Places, Assistants, Pinned, Chats) are the
 * same components as without the layout — Sidebar.tsx hands them in.
 */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  CheckIcon,
  CloudIcon,
  ExternalLinkIcon,
  FolderIcon,
  GripVerticalIcon,
  LaptopIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/utils";
import { useOpenApp } from "../navigation/useOpenApp";
import { homeWidgetSource } from "../components/computer/home/homeAppWidget.logic";
import { appWidgetSandbox } from "../components/computer/home/homeLayout";
import { isBrowserOnMachine } from "../components/computer/programModel";
import { useSidebarDComputers } from "../components/sidebar/SidebarDComputers";
import {
  BUILT_IN_INFO,
  findPresetApp,
  useWidgetApps,
  widgetAppOf,
  type WidgetApp,
} from "./catalog";
import {
  PRESETS,
  REQUIRED_BLOCK,
  addableBuiltIns,
  isBuiltInBlockId,
  resolvePreset,
  sidebarWidgetHeight,
  type BlockId,
  type BlockSize,
  type LayoutBlock,
} from "./layoutModel";
import { useLookStore } from "./lookStore";
import { useSidebarLayoutStore } from "./layoutStore";

const MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

// ------------------------------------------------------------ new blocks --

function BlockLabel(props: { label: string; action?: ReactNode }) {
  return (
    <div className="flex h-6 items-center pr-1 pl-2.5">
      <span className="flex-1 text-xs font-medium text-sidebar-muted-foreground/80">
        {props.label}
      </span>
      {props.action}
    </div>
  );
}

const ROW =
  "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-foreground/90 hover:bg-sidebar-row-hover hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0";

export const ComputersBlock = memo(function ComputersBlock() {
  const computers = useSidebarDComputers();
  return (
    <section aria-label="Computers" data-testid="block-computers">
      <BlockLabel label="Computers" />
      {computers.map((computer) => (
        <div key={computer.key} className={ROW}>
          {computer.cloud ? (
            <CloudIcon className="text-muted-foreground" />
          ) : (
            <LaptopIcon className="text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{computer.label}</span>
          <span
            className={cn(
              "text-[11px]",
              computer.status === "online" ? "text-emerald-600" : "text-muted-foreground/70",
            )}
          >
            {computer.status === "online"
              ? "online"
              : computer.status === "sleeping"
                ? "asleep"
                : computer.status}
          </span>
        </div>
      ))}
    </section>
  );
});

export const ProjectsBlock = memo(function ProjectsBlock(props: {
  projects: ReadonlyArray<{ key: string; name: string; chats: number }>;
  onOpen: (key: string) => void;
}) {
  return (
    <section aria-label="Projects" data-testid="block-projects">
      <BlockLabel label="Projects" />
      {props.projects.slice(0, 6).map((project) => (
        <button
          key={project.key}
          type="button"
          className={ROW}
          onClick={() => props.onOpen(project.key)}
        >
          <FolderIcon className="text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          <span className="text-[11px] text-muted-foreground/70">{project.chats}</span>
        </button>
      ))}
    </section>
  );
});

export const RunningAppsBlock = memo(function RunningAppsBlock() {
  const apps = useWidgetApps();
  const { openHere } = useOpenApp();
  return (
    <section aria-label="Running apps" data-testid="block-apps">
      <BlockLabel label="Running apps" />
      {apps.map((item) => (
        <button
          key={item.blockId}
          type="button"
          className={ROW}
          onClick={() =>
            item.app.url ? openHere({ url: item.app.url, name: item.app.name }) : undefined
          }
        >
          <span className="w-4 text-center text-sm leading-none">{item.app.icon ?? "▢"}</span>
          <span className="min-w-0 flex-1 truncate">{item.app.name}</span>
          <span
            className={cn(
              "size-1.5 rounded-full",
              item.app.status === "running" ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          />
        </button>
      ))}
    </section>
  );
});

/** The widget's address with Uno Work's look (`uno-theme`, `uno-accent`). */
function themedUrl(url: string, dark: boolean, accent: string | null): string {
  try {
    const next = new URL(url);
    next.searchParams.set("uno-theme", dark ? "dark" : "light");
    if (accent) next.searchParams.set("uno-accent", accent);
    return next.toString();
  } catch {
    return url;
  }
}

export const WidgetBlock = memo(function WidgetBlock(props: {
  item: WidgetApp | null;
  size: BlockSize | undefined;
}) {
  const { openHere } = useOpenApp();
  const accentHex = useLookStore((state) => state.accentHex());
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const item = props.item;
  if (!item) {
    return (
      <section className="px-2.5 py-2 text-xs text-muted-foreground/70">
        This app's computer is asleep — its widget comes back when it wakes.
      </section>
    );
  }
  const source = homeWidgetSource(item.app, {
    browserOnMachine: isBrowserOnMachine(window.location.hostname),
    cloudComputer: false,
  });
  const src = source?.kind === "direct" ? themedUrl(source.url, dark, accentHex) : null;
  return (
    <section aria-label={item.app.name} data-testid={`block-widget-${item.app.id}`}>
      <BlockLabel
        label={`${item.app.icon ?? ""} ${item.app.widget?.title ?? item.app.name}`.trim()}
        action={
          item.app.url ? (
            <button
              type="button"
              aria-label={`Open ${item.app.name}`}
              onClick={() => openHere({ url: item.app.url!, name: item.app.name })}
              className="inline-flex size-5 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
            >
              <ExternalLinkIcon className="size-3" />
            </button>
          ) : null
        }
      />
      <div className="mx-1 overflow-hidden rounded-lg border border-border/70 bg-card">
        {src ? (
          <iframe
            src={src}
            title={item.app.widget?.title ?? item.app.name}
            // The same fence as Home's widgets: never Work's origin, never top navigation.
            sandbox={appWidgetSandbox(src, window.location.origin)}
            referrerPolicy="strict-origin-when-cross-origin"
            className="block w-full border-0 bg-transparent"
            style={{ height: sidebarWidgetHeight(props.size) }}
          />
        ) : (
          <p className="p-3 text-xs text-muted-foreground">Starting…</p>
        )}
      </div>
    </section>
  );
});

// ------------------------------------------------------------- edit mode --

const SIZE_LABEL: Record<BlockSize, string> = { s: "S", m: "M", l: "L" };

function SortableBlock(props: {
  block: LayoutBlock;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const dispatch = useSidebarLayoutStore((state) => state.dispatch);
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.block.id });
  const required = props.block.id === REQUIRED_BLOCK;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "relative list-none rounded-xl border border-dashed border-primary/35 bg-primary/[0.03] p-1",
        isDragging && "z-20 border-solid bg-card shadow-lg",
      )}
      data-testid={`block-frame-${props.block.id}`}
    >
      <div className="flex h-7 items-center gap-1 pr-0.5 pl-0.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Move ${props.title}`}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-row-hover",
            isDragging ? "cursor-grabbing" : "cursor-grab",
          )}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <span className="text-muted-foreground [&_svg]:size-3.5">{props.icon}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground/85">
          {props.title}
        </span>
        {props.block.size !== undefined ? (
          <div
            className="flex items-center rounded-md border border-border/80 bg-background p-px"
            role="group"
            aria-label="Height"
          >
            {(["s", "m", "l"] as const).map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => dispatch({ type: "resize", id: props.block.id, size })}
                className={cn(
                  "h-5 w-5 rounded-[5px] text-[10px] font-semibold",
                  props.block.size === size
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {SIZE_LABEL[size]}
              </button>
            ))}
          </div>
        ) : null}
        {required ? (
          <span className="px-1 text-[10px] text-muted-foreground/70">always on</span>
        ) : (
          <button
            type="button"
            aria-label={`Hide ${props.title}`}
            onClick={() => dispatch({ type: "remove", id: props.block.id })}
            className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <div
        className={cn(
          "pointer-events-none select-none",
          // The chat list is long: a glimpse is enough to place it.
          props.block.id === "chats" &&
            "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
        )}
        aria-hidden
      >
        {props.children}
      </div>
    </li>
  );
}

/** A block's name and icon for the frame. */
export function useBlockTitle(): (block: LayoutBlock) => { title: string; icon: ReactNode } {
  const apps = useWidgetApps();
  return (block) => {
    if (isBuiltInBlockId(block.id)) {
      const info = BUILT_IN_INFO[block.id];
      return { title: info.title, icon: info.icon };
    }
    const item = widgetAppOf(apps, block.id);
    return {
      title: item ? `${item.app.name} · widget` : "App widget",
      icon: <span className="text-xs leading-none">{item?.app.icon ?? "▢"}</span>,
    };
  };
}

/** The blocks in edit mode: frames that drag up and down. */
export function SidebarBlocksEditor(props: { render: (block: LayoutBlock) => ReactNode }) {
  const blocks = useSidebarLayoutStore((state) => state.layout.blocks);
  const dispatch = useSidebarLayoutStore((state) => state.dispatch);
  const titleOf = useBlockTitle();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    dispatch({ type: "move", from: active.id as BlockId, to: over.id as BlockId });
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={MODIFIERS}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={blocks.map((block) => block.id)} strategy={verticalListSortingStrategy}>
        <ul role="list" className="flex flex-col gap-2" data-testid="sidebar-blocks-editor">
          {blocks.map((block) => {
            const { title, icon } = titleOf(block);
            return (
              <SortableBlock key={block.id} block={block} title={title} icon={icon}>
                {props.render(block)}
              </SortableBlock>
            );
          })}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

/** On top in edit mode: the presets and Done. */
export function SidebarEditBar() {
  const layout = useSidebarLayoutStore((state) => state.layout);
  const replace = useSidebarLayoutStore((state) => state.replace);
  const dispatch = useSidebarLayoutStore((state) => state.dispatch);
  const setEditing = useSidebarLayoutStore((state) => state.setEditing);
  const apps = useWidgetApps();
  return (
    <div
      className="mx-[var(--sidebar-content-inset)] mb-2 rounded-xl border border-primary/25 bg-primary/[0.05] p-2"
      data-testid="sidebar-edit-bar"
    >
      <div className="flex items-center gap-1.5">
        <span className="flex-1 pl-1 text-[13px] font-semibold">Customize sidebar</span>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="inline-flex h-6 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
          data-testid="sidebar-edit-done"
        >
          <CheckIcon className="size-3" />
          Done
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-1" role="radiogroup" aria-label="Presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={layout.preset === preset.id}
            title={preset.hint}
            onClick={() =>
              replace(
                {
                  blocks: resolvePreset(preset.id, (key) => findPresetApp(apps, key)),
                  preset: preset.id,
                },
                { kind: "preset", label: preset.title },
              )
            }
            className={cn(
              "h-6 rounded-full border px-2 text-[11px] font-medium",
              layout.preset === preset.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground/80 hover:border-primary/50",
            )}
          >
            {preset.title}
          </button>
        ))}
        {layout.preset === null ? (
          <span className="inline-flex h-6 items-center rounded-full border border-dashed border-border px-2.5 text-[11px] text-muted-foreground">
            Your own
          </span>
        ) : null}
      </div>
      <div className="mt-1.5 flex items-start gap-2 px-1">
        <p className="flex-1 text-[11px] leading-snug text-muted-foreground">
          Drag ⋮⋮ to reorder, × to hide. Same on all your devices.
        </p>
        <button
          type="button"
          onClick={() => dispatch({ type: "reset" })}
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <RotateCcwIcon className="size-3" />
          Reset
        </button>
      </div>
    </div>
  );
}

/** At the bottom in edit mode: opens the catalog. */
export function SidebarAddBlockButton() {
  const setCatalogOpen = useSidebarLayoutStore((state) => state.setCatalogOpen);
  return (
    <button
      type="button"
      onClick={() => setCatalogOpen(true)}
      className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/40 text-[13px] font-medium text-primary hover:bg-primary/[0.06]"
      data-testid="sidebar-add-block"
    >
      <PlusIcon className="size-4" />
      Add block
    </button>
  );
}

/** "Undo" after a preset or an agent changed the whole sidebar. */
export function SidebarLayoutUndoNote() {
  const changedBy = useSidebarLayoutStore((state) => state.changedBy);
  const undo = useSidebarLayoutStore((state) => state.undo);
  const undoReplace = useSidebarLayoutStore((state) => state.undoReplace);
  const [hidden, setHidden] = useState<string | null>(null);
  if (!changedBy || !undo || hidden === changedBy.label || changedBy.kind !== "agent") return null;
  return (
    <div
      className="mx-[var(--sidebar-content-inset)] mb-1.5 flex items-center gap-2 rounded-lg border border-border/80 bg-card px-2.5 py-1.5 text-[11.5px] shadow-xs"
      data-testid="sidebar-layout-undo"
    >
      <SparklesIcon className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-foreground/85">
        Sidebar set by <b className="font-medium">{changedBy.label}</b>
      </span>
      <button
        type="button"
        onClick={undoReplace}
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <Undo2Icon className="size-3" />
        Undo
      </button>
      <button
        type="button"
        aria-label="Hide"
        onClick={() => setHidden(changedBy.label)}
        className="text-muted-foreground/70 hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

// --------------------------------------------------------------- catalog --

function CatalogCard(props: {
  icon: ReactNode;
  title: string;
  hint: string;
  badge?: string;
  added: boolean;
  onAdd: () => void;
  testId?: string;
}) {
  return (
    <div
      className="flex items-start gap-3 rounded-xl border border-border/80 bg-card p-3"
      data-testid={props.testId}
    >
      <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/80 [&_svg]:size-4">
        {props.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold">{props.title}</span>
          {props.badge ? (
            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
              {props.badge}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{props.hint}</p>
      </div>
      {props.added ? (
        <span className="mt-1 inline-flex h-7 items-center gap-1 px-2 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5" />
          Added
        </span>
      ) : (
        <button
          type="button"
          onClick={props.onAdd}
          className="mt-0.5 inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:border-primary/60 hover:text-primary"
        >
          <PlusIcon className="size-3.5" />
          Add
        </button>
      )}
    </div>
  );
}

/** The catalog: built-in blocks, apps' widgets, and "ask an agent to make one". */
export function BlockCatalog(props: { left: string; onAskAgent: (text: string) => void }) {
  const open = useSidebarLayoutStore((state) => state.catalogOpen);
  const setOpen = useSidebarLayoutStore((state) => state.setCatalogOpen);
  const layout = useSidebarLayoutStore((state) => state.layout);
  const dispatch = useSidebarLayoutStore((state) => state.dispatch);
  const apps = useWidgetApps();
  const [ask, setAsk] = useState("");
  if (!open) return null;
  const inLayout = (id: string) => layout.blocks.some((block) => block.id === id);
  const addable = new Set(addableBuiltIns(layout));
  const builtIns = (Object.keys(BUILT_IN_INFO) as Array<keyof typeof BUILT_IN_INFO>).filter(
    (id) => id !== "chats",
  );
  const add = (id: BlockId, size?: BlockSize) =>
    // New blocks go just above the chats: that's where people look first.
    dispatch({
      type: "add",
      id,
      ...(size ? { size } : {}),
      at: Math.max(0, layout.blocks.findIndex((block) => block.id === "chats")),
    });
  return createPortal(
    <div
      role="dialog"
      aria-label="Add a block"
      className="fixed inset-y-3 z-40 flex w-[400px] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl animate-in fade-in-0 slide-in-from-left-2"
      style={{ left: props.left }}
      data-testid="block-catalog"
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <div className="flex-1">
          <p className="text-sm font-semibold">Add a block</p>
          <p className="text-xs text-muted-foreground">To the sidebar · drag it into place after</p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => setOpen(false)}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Uno Work
          </h3>
          {builtIns.map((id) => (
            <CatalogCard
              key={id}
              icon={BUILT_IN_INFO[id].icon}
              title={BUILT_IN_INFO[id].title}
              hint={BUILT_IN_INFO[id].hint}
              added={!addable.has(id)}
              onAdd={() => add(id)}
              testId={`catalog-${id}`}
            />
          ))}
        </section>
        <section className="space-y-2">
          <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            From your apps
          </h3>
          {apps.map((item) => (
            <CatalogCard
              key={item.blockId}
              icon={<span className="text-base leading-none">{item.app.icon ?? "▢"}</span>}
              title={item.app.widget?.title ?? item.app.name}
              hint={`${item.app.description ?? "Widget"} · its own sandboxed frame`}
              badge={item.computer}
              added={inLayout(item.blockId)}
              onAdd={() => add(item.blockId, item.app.widget?.size === "small" ? "s" : "m")}
              testId={`catalog-widget-${item.app.id}`}
            />
          ))}
        </section>
        <section className="space-y-2 rounded-xl border border-primary/25 bg-primary/[0.04] p-3">
          <div className="flex items-center gap-1.5">
            <SparklesIcon className="size-4 text-primary" />
            <h3 className="text-[13px] font-semibold">Make your own block</h3>
          </div>
          <p className="text-xs leading-snug text-muted-foreground">
            Say what it should show. An agent makes a small app with a widget on your computer — it
            sees only its own data.
          </p>
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (ask.trim()) props.onAskAgent(ask.trim());
            }}
          >
            <input
              value={ask}
              onChange={(event) => setAsk(event.target.value)}
              placeholder="Today's Stripe payments and refunds"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-xs outline-none focus:border-primary/60"
            />
            <button
              type="submit"
              className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground"
            >
              Ask Uno
            </button>
          </form>
        </section>
      </div>
    </div>,
    document.body,
  );
}


