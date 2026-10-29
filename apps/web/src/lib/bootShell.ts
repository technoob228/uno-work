/**
 * The splash from index.html (`#boot-shell`) lies over the app until its first
 * real screen is committed, then goes in the same frame — one hand-off
 * "logo → app" instead of "logo → blank → React's logo → app" (S6 29.10).
 *
 * Called from a layout effect of the root view (before the browser paints the
 * commit), from the root error view, and from the fatal screen — so a screen
 * with something to say is never left under the logo.
 */
export const BOOT_SHELL_ID = "boot-shell";

export function hideBootShell(doc: Document | undefined = globalThis.document): void {
  doc?.getElementById(BOOT_SHELL_ID)?.remove();
}
