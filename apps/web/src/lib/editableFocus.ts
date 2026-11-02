// Upstream T3 Code apps/web/src/lib/editableFocus.ts (5781b5240b): ⌘Z in a
// text field is the field's own undo, not the chat-action Undo.
const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

/** Includes focused descendants of open shadow roots, whose key events target the host. */
export function isEditableFocused(
  target: EventTarget | null = typeof document === "undefined" ? null : document.activeElement,
): boolean {
  let element = typeof Element !== "undefined" && target instanceof Element ? target : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element !== null && element.closest(EDITABLE_SELECTOR) !== null;
}

/**
 * ⌘S with a file open for editing saves the file, wherever the focus is,
 * unless the person is in the message box: there it keeps setting the draft
 * aside. Without this a click outside the text sent ⌘S to the message box.
 */
export function fileEditorOwnsSave(): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest('[data-chat-composer-form="true"]')) {
    return false;
  }
  const editor = document.querySelector("[data-file-editor]");
  return editor !== null && editor.getClientRects().length > 0;
}
