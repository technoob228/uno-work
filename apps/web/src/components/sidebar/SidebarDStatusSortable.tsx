/**
 * Sidebar grouped by status: the sections' headers drag up and down to put the
 * sections in the person's own order (Misha 02.11). The whole section moves
 * with its chats; only the header starts a drag, so chat rows keep their own
 * clicks and drags. A short move (6 px) before a drag starts keeps clicks on
 * the header clicks; Space or Enter on the focused header picks it up for the
 * arrow keys.
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
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

const MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

/** One list of status sections side by side (siblings in the tree). */
export function SidebarDStatusSortable(props: {
  ids: ReadonlyArray<string>;
  onMove: (moved: string, onto: string) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    props.onMove(String(active.id), String(over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={MODIFIERS}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={[...props.ids]} strategy={verticalListSortingStrategy}>
        {props.children}
      </SortableContext>
    </DndContext>
  );
}

/** A status section: its header is the handle, the chats under it move along. */
export function SidebarDStatusSection(props: {
  id: string;
  label: string;
  testId: string;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative list-none", isDragging && "z-20 opacity-80")}
      data-testid={props.testId}
    >
      <ul role="list" className="flex flex-col gap-px">
        <li className="list-none">
          <div
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`${props.label} section, drag to reorder`}
            data-testid={`sidebar-d-status-handle-${props.id}`}
            className={cn(
              "rounded-md px-2.5 pt-3 pb-1 text-xs font-medium text-sidebar-muted-foreground/70 outline-hidden select-none focus-visible:ring-2 focus-visible:ring-ring",
              isDragging ? "cursor-grabbing" : "cursor-grab",
            )}
          >
            {props.label}
          </div>
        </li>
        {props.children}
      </ul>
    </li>
  );
}
