/**
 * Home as a 4-column grid of blocks the person arranges (see homeLayout.ts):
 * the greeting, the composer and Continue (full width, no card), the built-in
 * widgets, and apps' own widgets (manifest `widget`). Customize: drag to
 * reorder, × to hide (the composer only moves), "Add widget" to bring one
 * back or to ask Uno for a custom one. Kept on this device.
 */
import {
  closestCenter,
  DndContext,
  pointerWithin,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
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
  ArrowLeftIcon,
  CloudIcon,
  HandIcon,
  ListChecksIcon,
  MessageSquarePlusIcon,
  SparklesIcon,
  SquarePenIcon,
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
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Button } from "../../ui/button";
import { ProgramIcon } from "../ComputerPrograms";
import {
  addableBlocks,
  isHomeBlockId,
  type HomeBlockId,
  type HomeFixedBlockId,
  type HomeLayoutAction,
} from "./homeLayout";
import type { HomeWidgetId } from "./homeModel";

export interface WidgetMeta {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  /** Columns out of 4 on a wide screen (4 = the whole row). */
  readonly span: 1 | 2 | 4;
  /** Shown without a card and title outside Customize (greeting, composer, Continue). */
  readonly bare?: boolean;
  /** × in Customize; false only for the composer. */
  readonly removable?: boolean;
}

export const HOME_FIXED_BLOCK_META: Record<HomeFixedBlockId, WidgetMeta> = {
  greeting: {
    title: "Greeting",
    description: "Good morning, and your name",
    icon: <HandIcon />,
    span: 4,
    bare: true,
    removable: true,
  },
  composer: {
    title: "Ask Uno",
    description: "Type a task; the suggestions under it",
    icon: <SquarePenIcon />,
    span: 4,
    bare: true,
    removable: false,
  },
  continue: {
    title: "Continue",
    description: "Chats and notifications that need you or are worth picking up",
    icon: <ListChecksIcon />,
    span: 4,
    bare: true,
    removable: true,
  },
};

const SPAN_CLASS: Record<WidgetMeta["span"], string> = {
  1: "col-span-1",
  2: "col-span-2",
  4: "col-span-2 md:col-span-4",
};

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
    title: "Uno AI",
    description: "AI hours left and today's use, or spend and credits left",
    icon: <WalletIcon />,
    span: 1,
  },
};

/** The block under the pointer wins; the nearest one only when the pointer is in a gap. */
const pointerFirst: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  return within.length > 0 ? within : closestCenter(args);
};

export function HomeWidgetGrid({
  blocks,
  editing,
  dispatch,
  metaOf,
  render,
}: {
  blocks: ReadonlyArray<HomeBlockId>;
  editing: boolean;
  dispatch: (action: HomeLayoutAction) => void;
  metaOf: (id: HomeBlockId) => WidgetMeta;
  /** The block's body and an optional link at the right of its title. */
  render: (id: HomeBlockId) => { body: ReactNode; action?: ReactNode };
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    if (!isHomeBlockId(active.id) || !isHomeBlockId(over.id)) return;
    dispatch({ type: "move", from: active.id, to: over.id });
  };
  return (
    <DndContext sensors={sensors} collisionDetection={pointerFirst} onDragEnd={onDragEnd}>
      <SortableContext items={[...blocks]} strategy={rectSortingStrategy}>
        <div
          className="grid grid-flow-row-dense grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-4"
          data-testid="home-widgets"
        >
          {blocks.map((id) => {
            const { body, action } = render(id);
            return (
              <WidgetFrame
                key={id}
                id={id}
                meta={metaOf(id)}
                editing={editing}
                action={action}
                onRemove={() => dispatch({ type: "remove", id })}
              >
                {body}
              </WidgetFrame>
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function WidgetFrame({
  id,
  meta,
  editing,
  action,
  onRemove,
  children,
}: {
  id: HomeBlockId;
  meta: WidgetMeta;
  editing: boolean;
  action?: ReactNode;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editing,
  });
  const removable = meta.removable !== false;
  if (meta.bare && !editing) {
    return (
      <div
        ref={setNodeRef}
        data-testid={`home-widget-${id}`}
        className={cn("flex min-w-0 flex-col gap-2.5", SPAN_CLASS[meta.span])}
      >
        {id === "continue" ? <h2 className="text-sm font-semibold">{meta.title}</h2> : null}
        {children}
      </div>
    );
  }
  return (
    <section
      ref={setNodeRef}
      // Translate only: blocks differ a lot in size, and the sorting strategy's
      // scale would squash a full-width block into a small slot mid-drag.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={`home-widget-${id}`}
      aria-label={meta.title}
      className={cn(
        "relative flex min-w-0 flex-col gap-3 rounded-2xl p-4",
        meta.bare ? "bg-transparent" : "border border-border/70 bg-card shadow-xs/5",
        SPAN_CLASS[meta.span],
        editing && "cursor-grab border border-dashed border-primary/40",
        isDragging && "z-10 cursor-grabbing bg-background shadow-xl",
      )}
      {...(editing ? { ...attributes, ...listeners } : {})}
    >
      <header className="flex min-w-0 items-center gap-2 text-sm font-semibold [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
        {editing ? <GripVerticalIcon className="-ml-1" /> : null}
        {meta.icon}
        <h2 className="truncate">{meta.title}</h2>
        <div className="ml-auto flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground">
          {editing ? (removable ? null : "Can move, can't be removed") : action}
        </div>
        {editing && removable ? (
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

/** An app that declares a Home widget, for "Add widget". */
export interface AddableAppWidget {
  readonly id: HomeBlockId;
  readonly name: string;
  readonly icon: string | null;
  readonly iconImage: string | null;
  readonly title: string;
}

export function AddWidgetDialog({
  open,
  onOpenChange,
  blocks,
  available,
  metaOf,
  appWidgets,
  customIdeas,
  onAskForWidget,
  dispatch,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blocks: ReadonlyArray<HomeBlockId>;
  /** Built-in blocks available here (fixed ones and widgets). */
  available: ReadonlyArray<HomeBlockId>;
  metaOf: (id: HomeBlockId) => WidgetMeta;
  /** Apps on this computer that declare a widget. */
  appWidgets: ReadonlyArray<AddableAppWidget>;
  /** Ideas for "Add custom widget", from the person's apps. */
  customIdeas: ReadonlyArray<string>;
  /** Opens a new chat with `prompt` typed in (not sent). */
  onAskForWidget: (prompt: string) => void;
  dispatch: (action: HomeLayoutAction) => void;
}) {
  const [custom, setCustom] = useState(false);
  const missing = addableBlocks(blocks, available);
  const missingApps = appWidgets.filter((app) => !blocks.includes(app.id));
  const close = (next: boolean) => {
    if (!next) setCustom(false);
    onOpenChange(next);
  };
  const add = (id: HomeBlockId) => {
    dispatch({ type: "add", id });
    close(false);
  };
  const example = "Make a Home widget that shows today's orders from my shop site";
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="max-w-md">
        {custom ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a custom widget</DialogTitle>
              <DialogDescription>
                Ask Uno to make a widget, e.g. “{example}” — it will appear here, under Add widget.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3" data-testid="custom-widget-panel">
              <Button
                onClick={() => {
                  onAskForWidget(`${example}.`);
                  close(false);
                }}
                data-testid="custom-widget-ask"
              >
                <MessageSquarePlusIcon />
                Ask Uno to make a widget
              </Button>
              <p className="text-xs font-medium text-muted-foreground">Or start from an idea</p>
              {customIdeas.map((idea) => (
                <button
                  key={idea}
                  type="button"
                  onClick={() => {
                    onAskForWidget(`${idea}.`);
                    close(false);
                  }}
                  className="flex items-start gap-2 rounded-xl border border-border/70 p-3 text-left text-sm transition-colors hover:bg-accent/50"
                >
                  <SparklesIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                  {idea}
                </button>
              ))}
              <p className="text-xs text-muted-foreground">
                Uno builds a small page in one of your apps and registers it as a widget; you check
                the chat before anything is sent.
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => setCustom(false)}
              >
                <ArrowLeftIcon />
                Back
              </Button>
            </DialogPanel>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add a widget</DialogTitle>
              <DialogDescription>Pick what else you want to see on Home.</DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-2">
              {missing.map((id) => {
                const meta = metaOf(id);
                return (
                  <AddRow
                    key={id}
                    icon={meta.icon}
                    title={meta.title}
                    description={meta.description}
                    onClick={() => add(id)}
                  />
                );
              })}
              {missingApps.map((app) => (
                <AddRow
                  key={app.id}
                  icon={
                    <ProgramIcon
                      name={app.name}
                      icon={app.icon}
                      iconImage={app.iconImage}
                      className="size-8 rounded-lg text-sm"
                    />
                  }
                  bareIcon
                  title={app.title}
                  description={`A widget of ${app.name}`}
                  onClick={() => add(app.id)}
                />
              ))}
              <AddRow
                icon={<SparklesIcon />}
                title="Add custom widget"
                description="Ask Uno to make one — from your apps, your files, anything"
                onClick={() => setCustom(true)}
                testId="add-custom-widget"
              />
            </DialogPanel>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function AddRow({
  icon,
  bareIcon,
  title,
  description,
  onClick,
  testId,
}: {
  icon: ReactNode;
  bareIcon?: boolean;
  title: string;
  description: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex items-center gap-3 rounded-xl border border-border/70 p-3 text-left transition-colors hover:bg-accent/50"
    >
      {bareIcon ? (
        icon
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-4">
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <PlusIcon className="size-4 text-muted-foreground" />
    </button>
  );
}
