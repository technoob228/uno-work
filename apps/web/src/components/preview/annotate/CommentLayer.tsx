/**
 * Comment mode over the page (w0138): the note box at the element the
 * person clicked (or the area they dragged), and the bar at the bottom —
 * "3 comments · Clear · Send to chat". The highlight and the numbered pins
 * are drawn inside the page (pageToolsScript.ts); this is the app's part.
 */
import { MessageSquarePlusIcon } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { commentsPayload } from "./pageTools.logic";
import { usePageToolsStore, usePageToolsTab } from "./pageToolsStore";
import { useSendToChat } from "./sendToChat";

const NOTE_WIDTH = 272;

export function CommentLayer({
  tabId,
  pageUrl,
  pageRef,
  zoom = 1,
}: {
  tabId: string;
  pageUrl: string;
  /** The element the page is drawn in (webview / iframe): the note box is placed against it. */
  pageRef: RefObject<HTMLElement | null>;
  zoom?: number;
}) {
  const tab = usePageToolsTab(tabId);
  const store = usePageToolsStore;
  const sendToChat = useSendToChat();
  const layerRef = useRef<HTMLDivElement | null>(null);
  const draft = tab.draft;
  const editing =
    draft?.kind === "edit" ? (tab.comments.find((c) => c.id === draft.commentId) ?? null) : null;

  // Where the note box goes: under the picked element, or above it near the bottom.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!draft || draft.kind !== "new") {
      setPosition(null);
      return;
    }
    const layer = layerRef.current?.getBoundingClientRect();
    const page = pageRef.current?.getBoundingClientRect();
    if (!layer || !page) return;
    const rect = draft.pick.rect;
    const offsetX = page.left - layer.left;
    const offsetY = page.top - layer.top;
    const below = offsetY + (rect.y + rect.h) * zoom + 8;
    const fitsBelow = below + 150 < layer.height;
    const top = fitsBelow ? below : Math.max(8, offsetY + rect.y * zoom - 150 - 8);
    const left = Math.min(
      Math.max(8, offsetX + rect.x * zoom),
      Math.max(8, layer.width - NOTE_WIDTH - 8),
    );
    setPosition({ left, top });
  }, [draft, pageRef, zoom]);

  const send = () => {
    if (tab.comments.length === 0) return;
    const ok = sendToChat(commentsPayload({ page: pageUrl, comments: tab.comments }));
    if (ok) store.getState().patch(tabId, { comments: [], commenting: false, draft: null });
  };

  if (!tab.commenting && tab.comments.length === 0 && !draft) return null;

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {draft ? (
        <NoteBox
          key={
            draft.kind === "edit" ? draft.commentId : `${draft.pick.rect.x}:${draft.pick.rect.y}`
          }
          style={
            draft.kind === "new" && position
              ? { left: position.left, top: position.top }
              : { left: "50%", bottom: 52, transform: "translateX(-50%)" }
          }
          title={
            editing ? `Comment ${editing.n}` : draft.kind === "new" ? draft.pick.label : "Comment"
          }
          detail={editing ? editing.label : draft.kind === "new" ? draft.pick.text : null}
          initial={editing?.note ?? ""}
          onSave={(note) => store.getState().saveDraft(tabId, note)}
          onCancel={() => store.getState().patch(tabId, { draft: null })}
          {...(editing
            ? { onDelete: () => store.getState().removeComment(tabId, editing.id) }
            : {})}
        />
      ) : null}
      <div className="pointer-events-auto absolute bottom-3 left-1/2 flex h-9 max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-popover py-1 pr-1 pl-2.5 text-xs text-popover-foreground shadow-lg">
        {tab.comments.length === 0 ? (
          <>
            <MessageSquarePlusIcon className="size-3.5 shrink-0 text-primary" />
            <span className="truncate">
              Click anything to comment
              <span className="text-muted-foreground"> · Shift+drag for an area</span>
            </span>
            <Button
              size="xs"
              variant="ghost"
              className="ml-1 shrink-0"
              onClick={() => store.getState().patch(tabId, { commenting: false, draft: null })}
            >
              Done
              <kbd className="font-sans text-[10px] text-muted-foreground">Esc</kbd>
            </Button>
          </>
        ) : (
          <>
            <span className="inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {tab.comments.length}
            </span>
            <span className="truncate font-medium" data-testid="browser-comments-count">
              {tab.comments.length === 1 ? "1 comment" : `${tab.comments.length} comments`}
            </span>
            <Button
              size="xs"
              variant="ghost"
              className="ml-1 shrink-0"
              onClick={() => store.getState().clearComments(tabId)}
            >
              Clear
            </Button>
            <Button
              size="xs"
              className="shrink-0"
              onClick={send}
              data-testid="browser-comments-send"
            >
              Send to chat
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function NoteBox({
  style,
  title,
  detail,
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  style: React.CSSProperties;
  title: string;
  detail: string | null;
  initial: string;
  onSave: (note: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [note, setNote] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const save = () => {
    if (note.trim()) onSave(note.trim());
  };
  return (
    <div
      className="pointer-events-auto absolute z-10 flex flex-col gap-1.5 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl"
      style={{ width: NOTE_WIDTH, ...style }}
      data-testid="browser-comment-note"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="min-w-0 px-0.5">
        <div className="truncate font-mono text-[10.5px] text-primary">{title}</div>
        {detail ? (
          <div className="truncate text-[11px] text-muted-foreground">“{detail}”</div>
        ) : null}
      </div>
      <textarea
        ref={inputRef}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save();
          }
        }}
        rows={2}
        placeholder="What should change here?"
        className="min-h-12 w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
      />
      <div className="flex items-center gap-1">
        {onDelete ? (
          <Button size="xs" variant="ghost" className="text-destructive" onClick={onDelete}>
            Delete
          </Button>
        ) : null}
        <span className="ml-auto" />
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" onClick={save} disabled={!note.trim()} className={cn("gap-1")}>
          {onDelete ? "Save" : "Add"}
          <kbd className="font-sans text-[10px] opacity-70">⏎</kbd>
        </Button>
      </div>
    </div>
  );
}
