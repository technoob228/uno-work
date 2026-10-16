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

/**
 * The browser's bottom strip while commenting: what to do, how many notes,
 * Clear and Send to chat. A strip of the browser, not a card over the page.
 */
export function CommentBar({ tabId, pageUrl }: { tabId: string; pageUrl: string }) {
  const tab = usePageToolsTab(tabId);
  const store = usePageToolsStore;
  const sendToChat = useSendToChat();
  if (!tab.commenting && tab.comments.length === 0) return null;
  const send = () => {
    if (tab.comments.length === 0) return;
    const ok = sendToChat(commentsPayload({ page: pageUrl, comments: tab.comments }));
    if (ok) store.getState().patch(tabId, { comments: [], commenting: false, draft: null });
  };
  const count = tab.comments.length;
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-1.5 border-t border-border bg-card pr-1 pl-2.5 text-xs"
      data-testid="browser-comment-bar"
    >
      <MessageSquarePlusIcon className="size-3.5 shrink-0 text-primary" />
      {count > 0 ? (
        <span className="shrink-0 font-medium" data-testid="browser-comments-count">
          {count === 1 ? "1 comment" : `${count} comments`}
        </span>
      ) : null}
      {tab.commenting ? (
        <span className="min-w-0 truncate text-muted-foreground">
          {count > 0 ? "· " : ""}Click anything to leave a note · Shift+drag for an area
        </span>
      ) : null}
      <span className="ml-auto" />
      {count > 0 ? (
        <>
          <Button size="xs" variant="ghost" onClick={() => store.getState().clearComments(tabId)}>
            Clear
          </Button>
          <Button size="xs" onClick={send} data-testid="browser-comments-send">
            Send to chat
          </Button>
        </>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => store.getState().patch(tabId, { commenting: false, draft: null })}
        >
          Done
          <kbd className="font-sans text-[10px] text-muted-foreground">Esc</kbd>
        </Button>
      )}
    </div>
  );
}

export function CommentLayer({
  tabId,
  pageRef,
  zoom = 1,
}: {
  tabId: string;
  /** The element the page is drawn in (webview / iframe): the note box is placed against it. */
  pageRef: RefObject<HTMLElement | null>;
  zoom?: number;
}) {
  const tab = usePageToolsTab(tabId);
  const store = usePageToolsStore;
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

  if (!draft) return null;

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <NoteBox
        key={draft.kind === "edit" ? draft.commentId : `${draft.pick.rect.x}:${draft.pick.rect.y}`}
        style={
          draft.kind === "new" && position
            ? { left: position.left, top: position.top }
            : { left: "50%", bottom: 12, transform: "translateX(-50%)" }
        }
        title={
          editing ? `Comment ${editing.n}` : draft.kind === "new" ? draft.pick.label : "Comment"
        }
        detail={editing ? editing.label : draft.kind === "new" ? draft.pick.text : null}
        initial={editing?.note ?? ""}
        onSave={(note) => store.getState().saveDraft(tabId, note)}
        onCancel={() => store.getState().patch(tabId, { draft: null })}
        {...(editing ? { onDelete: () => store.getState().removeComment(tabId, editing.id) } : {})}
      />
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
