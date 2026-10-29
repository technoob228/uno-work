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
