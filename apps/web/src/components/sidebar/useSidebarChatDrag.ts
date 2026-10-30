/**
 * A chat's row in the sidebar as a drag source and a drop target: drag it on
 * another chat (or a selection of them) and the agent there gets their
 * transcript; drop files on it and they wait in that chat's box.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type DragEvent, useCallback, useMemo, useState } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import {
  acceptsChatDrop,
  readChatDrag,
  useComposerDropStore,
  writeChatDrag,
} from "../chat/chatDrop";

/** The chat being dragged, or the whole selection when it is part of one. */
function chatsToDrag(threadRef: ScopedThreadRef): ScopedThreadRef[] {
  const selection = useThreadSelectionStore.getState().selectedThreadKeys;
  if (!selection.has(scopedThreadKey(threadRef))) return [threadRef];
  return [...selection].flatMap((key) => parseScopedThreadKey(key) ?? []);
}

export function useSidebarChatDrag(threadRef: ScopedThreadRef) {
  const navigate = useNavigate();
  const [dropTarget, setDropTarget] = useState(false);

  const onDragStart = useCallback(
    (event: DragEvent<HTMLElement>) => writeChatDrag(event.dataTransfer, chatsToDrag(threadRef)),
    [threadRef],
  );
  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!acceptsChatDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(true);
  }, []);
  const onDragLeave = useCallback(() => setDropTarget(false), []);
  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      setDropTarget(false);
      if (!acceptsChatDrop(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const targetKey = scopedThreadKey(threadRef);
      const chats = readChatDrag(event.dataTransfer).filter(
        (chat) => scopedThreadKey(chat) !== targetKey,
      );
      const files = Array.from(event.dataTransfer.files);
      if (chats.length === 0 && files.length === 0) return;
      useComposerDropStore.getState().offer(targetKey, { files, chats });
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
    },
    [navigate, threadRef],
  );

  return useMemo(
    () => ({
      draggable: true,
      onDragStart,
      onDragOver,
      onDragLeave,
      onDrop,
      "data-chat-drop-target": dropTarget ? "" : undefined,
    }),
    [dropTarget, onDragLeave, onDragOver, onDragStart, onDrop],
  );
}
