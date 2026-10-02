/**
 * The collapsed sidebar D: a rail of icons that never hides, and a chats
 * panel that slides out over the page when the pointer rests on Uno or Chats
 * (~0.15 s) and hides itself 0.3 s after the pointer leaves, at once on a
 * click into the page, on Esc, or when a chat is picked. A click on Uno or
 * Chats opens it right away. Pure timing, no DOM: the rail and the panel call
 * these, and tests drive them with fake timers.
 */
import { SIDEBAR_D_PANEL_CLOSE_DELAY_MS, SIDEBAR_D_PANEL_OPEN_DELAY_MS } from "./sidebarD.logic";

export interface HoverPanelTimers {
  readonly set: (callback: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const DEFAULT_TIMERS: HoverPanelTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class HoverPanelController {
  private openTimer: unknown = null;
  private closeTimer: unknown = null;
  private isOpen = false;

  constructor(
    private readonly onChange: (open: boolean) => void,
    private readonly timers: HoverPanelTimers = DEFAULT_TIMERS,
  ) {}

  get open(): boolean {
    return this.isOpen;
  }

  /** The pointer came onto Uno or Chats on the rail. */
  enterTrigger(): void {
    this.cancelClose();
    if (this.isOpen || this.openTimer !== null) return;
    this.openTimer = this.timers.set(() => {
      this.openTimer = null;
      this.set(true);
    }, SIDEBAR_D_PANEL_OPEN_DELAY_MS);
  }

  /** The pointer came onto the panel: it stays. */
  enterPanel(): void {
    this.cancelClose();
  }

  /** The pointer left the trigger or the panel. */
  leave(): void {
    this.cancelOpen();
    if (!this.isOpen || this.closeTimer !== null) return;
    this.closeTimer = this.timers.set(() => {
      this.closeTimer = null;
      this.set(false);
    }, SIDEBAR_D_PANEL_CLOSE_DELAY_MS);
  }

  /** A click on Uno or Chats. */
  openNow(): void {
    this.cancelOpen();
    this.cancelClose();
    this.set(true);
  }

  /** A click into the page, Esc, or a chat picked. */
  closeNow(): void {
    this.cancelOpen();
    this.cancelClose();
    this.set(false);
  }

  dispose(): void {
    this.cancelOpen();
    this.cancelClose();
  }

  private set(open: boolean): void {
    if (this.isOpen === open) return;
    this.isOpen = open;
    this.onChange(open);
  }

  private cancelOpen(): void {
    if (this.openTimer === null) return;
    this.timers.clear(this.openTimer);
    this.openTimer = null;
  }

  private cancelClose(): void {
    if (this.closeTimer === null) return;
    this.timers.clear(this.closeTimer);
    this.closeTimer = null;
  }
}
