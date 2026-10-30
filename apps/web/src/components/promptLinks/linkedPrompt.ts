/**
 * Puts a linked prompt in a chat's box: no send, no model (upstream
 * `promptLinks/linkedPrompt`). A draft the person typed is never replaced
 * without asking. The words come from whoever made the link, so this chat
 * starts on confirmations even for someone on Full access (Misha 30.10); the
 * picker in the box can change that, for this chat only.
 */
import type { RuntimeMode } from "@t3tools/contracts";
import type { LinkedPrompt } from "@t3tools/shared/promptLinks";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";

import { toastManager } from "../ui/toast";

const READ_IT_MS = 12_000;
const LINKED_PROMPT_RUNTIME_MODE: RuntimeMode = "approval-required";

function warnAboutHiddenCharacters(prompt: LinkedPrompt): void {
  if (prompt.hiddenCharacters === 0) return;
  toastManager.add({
    type: "warning",
    title: "This prompt had hidden characters, it may be malicious",
    description: `Work removed ${prompt.hiddenCharacters} hidden character${prompt.hiddenCharacters === 1 ? "" : "s"}. Read the prompt before you send it.`,
    timeout: 0,
  });
}

export function placeLinkedPrompt(target: ComposerThreadTarget, prompt: LinkedPrompt): void {
  warnAboutHiddenCharacters(prompt);
  const place = () => {
    const drafts = useComposerDraftStore.getState();
    drafts.setPrompt(target, prompt.text);
    drafts.setRuntimeMode(target, LINKED_PROMPT_RUNTIME_MODE);
    drafts.setDraftThreadContext(target, { runtimeMode: LINKED_PROMPT_RUNTIME_MODE });
    toastManager.add({
      type: "info",
      title: "Prompt added from a link",
      description: "Nothing was sent. Read it before you send.",
      timeout: READ_IT_MS,
    });
  };
  const existing = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  if (existing.trim().length === 0 || existing === prompt.text) {
    place();
    return;
  }
  const id = toastManager.add({
    type: "info",
    title: "Prompt from a link",
    description: "This chat already has a draft. Replace it with the linked prompt?",
    timeout: 0,
    actionProps: {
      children: "Replace draft",
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}
