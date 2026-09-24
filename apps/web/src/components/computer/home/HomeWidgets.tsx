/**
 * Home's widgets: a 4-column grid under "Continue" the person arranges
 * themselves. Customize mode: drag to reorder, × to remove, "Add widget" to
 * bring one back; the layout is kept on this device.
 *
 * Only built-in widgets for now (the prototype's set) — apps can't bring their
 * own (Uptime Kuma, n8n…) until the App SDK has a widget contract.
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
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CloudIcon,
  FolderIcon,
  GlobeIcon,
  GripVerticalIcon,
  LayoutGridIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  MonitorIcon,
  PlusIcon,
  WalletIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import {
  addableWidgets,
  isHomeWidgetId,
  type HomeWidgetId,
  type HomeWidgetsAction,
} from "./homeModel";

interface WidgetMeta {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  /** Columns out of 4. */
  readonly span: 1 | 2;
}

export const HOME_WIDGETS: Record<HomeWidgetId, WidgetMeta> = {
  files: {
    title: "Files",
    description: "What changed lately in your home folder, and your cloud",
    icon: <FolderIcon />,
    span: 2,
  },
  apps: {
    title: "Apps",
    description: "Uno, Files, Terminal, the App Store and this computer's apps",
    icon: <LayoutGridIcon />,
    span: 2,
  },
  computer: {
    title: "This computer",
    description: "On or asleep, how busy, Boost",
    icon: <MonitorIcon />,
    span: 2,
  },
  "needs-you": {
    title: "Needs you",
    description: "Chats waiting for your OK or an answer",
    icon: <MessageCircleQuestionIcon />,
    span: 2,
  },
  "recent-chats": {
    title: "Recent chats",
    description: "Your latest chats",
    icon: <MessagesSquareIcon />,
    span: 2,
  },
  cloud: {
    title: "Cloud",
    description: "How much of your cloud storage is used",
    icon: <CloudIcon />,
    span: 1,
  },
  sites: {
    title: "Sites",
    description: "Your sites on Uno Hosting",
    icon: <GlobeIcon />,
    span: 1,
  },
  "ai-spend": {
    title: "Uno AI spend",
    description: "Spent today, the last 7 days, credits left",
    icon: <WalletIcon />,
    span: 1,
  },
};

export function HomeWidgetGrid({
  widgets,
  editing,
  dispatch,
  onAdd,
  render,
}: {
  widgets: ReadonlyArray<HomeWidgetId>;
  editing: boolean;
  dispatch: (action: HomeWidgetsAction) => void;
  onAdd: () => void;
  /** The widget's body and an optional link at the right of its title. */
  render: (id: HomeWidgetId) => { body: ReactNode; action?: ReactNode };
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    if (!isHomeWidgetId(active.id) || !isHomeWidgetId(over.id)) return;
    dispatch({ type: "move", from: active.id, to: over.id });
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={[...widgets]} strategy={rectSortingStrategy}>
        <div
          className="grid grid-flow-row-dense grid-cols-2 gap-4 md:grid-cols-4"
          data-testid="home-widgets"
        >
          {widgets.map((id) => {
            const { body, action } = render(id);
            return (
              <WidgetFrame
                key={id}
                id={id}
                editing={editing}
                action={action}
                onRemove={() => dispatch({ type: "remove", id })}
              >
                {body}
              </WidgetFrame>
            );
          })}
          {editing ? (
            <button
              type="button"
              onClick={onAdd}
              className="col-span-2 flex min-h-40 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground md:col-span-1"
            >
              <PlusIcon className="size-5" />
              Add widget
            </button>
          ) : null}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function WidgetFrame({
  id,
  editing,
  action,
  onRemove,
  children,
}: {
  id: HomeWidgetId;
  editing: boolean;
  action?: ReactNode;
  onRemove: () => void;
  children: ReactNode;
}) {
  const meta = HOME_WIDGETS[id];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editing,
  });
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid={`home-widget-${id}`}
      aria-label={meta.title}
      className={cn(
        "relative flex min-w-0 flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 shadow-xs/5",
        meta.span === 2 ? "col-span-2" : "col-span-1",
        editing && "cursor-grab border-dashed border-primary/40",
        isDragging && "z-10 cursor-grabbing shadow-xl",
      )}
      {...(editing ? { ...attributes, ...listeners } : {})}
    >
      <header className="flex min-w-0 items-center gap-2 text-sm font-semibold [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
        {editing ? <GripVerticalIcon className="-ml-1" /> : null}
        {meta.icon}
        <h2 className="truncate">{meta.title}</h2>
        <div className="ml-auto flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground">
          {editing ? null : action}
        </div>
        {editing ? (
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={onRemove}
            aria-label={`Remove ${meta.title}`}
            className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
      </header>
      <div className={cn("min-w-0 flex-1", editing && "pointer-events-none select-none")}>
        {children}
      </div>
    </section>
  );
}

export function AddWidgetDialog({
  open,
  onOpenChange,
  widgets,
  available,
  dispatch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  widgets: ReadonlyArray<HomeWidgetId>;
  available: ReadonlyArray<HomeWidgetId>;
  dispatch: (action: HomeWidgetsAction) => void;
}) {
  const missing = addableWidgets(widgets, available);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a widget</DialogTitle>
          <DialogDescription>Pick what else you want to see on Home.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2">
          {missing.length === 0 ? (
            <p className="text-sm text-muted-foreground">Every widget is already on your Home.</p>
          ) : null}
          {missing.map((id) => {
            const meta = HOME_WIDGETS[id];
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  dispatch({ type: "add", id });
                  onOpenChange(false);
                }}
                className="flex items-center gap-3 rounded-xl border border-border/70 p-3 text-left transition-colors hover:bg-accent/50"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-4">
                  {meta.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{meta.title}</span>
                  <span className="block text-xs text-muted-foreground">{meta.description}</span>
                </span>
                <PlusIcon className="size-4 text-muted-foreground" />
              </button>
            );
          })}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
