/**
 * When the main process may hand a page's Debug lines to the page's
 * preload (which passes them to the app, in order with its own messages):
 *
 *   - only after the app asked for Comment / Debug in this tab once
 *     (`enable`): an older app that doesn't use the preload gets nothing;
 *   - only once the current page's preload is up (`hello`, sent at the start
 *     of every page): lines of a page that is still loading wait for it;
 *   - a new page drops what the old one left unsent (`navigationStarted`).
 *
 * Waiting lines are capped, so a busy page in a tab nobody looks at can't
 * grow memory.
 */
export const RELAY_BUFFER_CAP = 600;

export class PageToolsRelay<M> {
  private enabled = false;
  private ready = false;
  private buffer: M[] = [];

  /** The app asked for the tools in this tab (stays on for the tab's life). */
  enable(): M[] {
    this.enabled = true;
    return this.flush();
  }

  /** The current page's preload is listening. */
  hello(): M[] {
    this.ready = true;
    return this.flush();
  }

  /** A new page starts loading in the tab. */
  navigationStarted(): void {
    this.ready = false;
    this.buffer = [];
  }

  /** A line to deliver: now, or later. */
  push(message: M): M[] {
    if (this.enabled && this.ready) return [message];
    this.buffer.push(message);
    if (this.buffer.length > RELAY_BUFFER_CAP) {
      this.buffer.splice(0, this.buffer.length - RELAY_BUFFER_CAP);
    }
    return [];
  }

  private flush(): M[] {
    if (!this.enabled || !this.ready || this.buffer.length === 0) return [];
    const out = this.buffer;
    this.buffer = [];
    return out;
  }
}
