/**
 * Panel → chat: what Comment and Debug send lands in the chat's composer as
 * one attachment card (the composer's own file attachments — on send the
 * markdown goes to the computer like any attached file, and the agent reads
 * it). Nothing is sent by itself: the person adds words and presses Send.
 */
import { useCallback } from "react";

import { useComposerHandleContext } from "../../../composerHandleContext";
import type { ComposerFileAttachment } from "../../../composerDraftStore";
import { toastManager } from "../../ui/toast";
import type { PanelContextPayload } from "./pageTools.logic";

export function makePanelContextFile(payload: PanelContextPayload): ComposerFileAttachment {
  const file = new File([payload.markdown], payload.fileName, { type: "text/markdown" });
  return {
    type: "file",
    id: `panel-${crypto.randomUUID()}`,
    name: payload.fileName,
    mimeType: "text/markdown",
    sizeBytes: file.size,
    file,
    panelContext: payload.card,
  };
}

/** Put a card into the chat's composer; false — no chat composer on screen (it says so). */
export function useSendToChat(): (payload: PanelContextPayload, text?: string) => boolean {
  const composerRef = useComposerHandleContext();
  return useCallback(
    (payload, text) => {
      const composer = composerRef?.current;
      if (!composer?.attachFromPanel) {
        toastManager.add({
          type: "info",
          title: "Open a chat to send this",
          description: "Comments and errors go to the chat next to the panel.",
        });
        return false;
      }
      composer.attachFromPanel({
        files: [makePanelContextFile(payload)],
        ...(text ? { text } : {}),
      });
      return true;
    },
    [composerRef],
  );
}
