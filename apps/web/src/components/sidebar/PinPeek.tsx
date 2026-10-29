/**
 * A glance at a pinned app without leaving the page (Misha 29.10): hover a
 * pinned app that has a Home widget (manifest `widget`) and its widget shows
 * in a card beside the sidebar, with Open. The card stays while the pointer
 * is on the pin or on the card, so its button can be pressed; it closes a
 * moment after the pointer leaves both, on Escape, or when the pin is
 * clicked. Once shown, a card stays mounted (hidden): the next glance is
 * instant, the widget doesn't load again.
 */
import type { EnvironmentId, UnoMachineApp, UnoPin } from "@t3tools/contracts";
import { ArrowUpRightIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { belongsToComputer } from "../apps/appAddress";
import { ProgramIcon } from "../computer/ComputerPrograms";
import { HomeAppWidget } from "../computer/home/HomeAppWidget";
import type { ProgramTile } from "../computer/programModel";
import { useProgramTiles } from "../computer/useProgramTiles";

const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 180;

/**
 * The app of this computer a pin opens: pins keep the address the app opened
 * at (its tile's `openUrl`); an address of another origin is no app of ours.
 */
export function pinnedMachineApp(
  item: UnoPin,
  tiles: ReadonlyArray<ProgramTile>,
): UnoMachineApp | null {
  if (item.kind !== "app") return null;
  const exact = tiles.find(
    (tile) =>
      tile.machineApp !== null &&
      (tile.openUrl === item.target || tile.machineApp.url === item.target),
  );
  if (exact) return exact.machineApp;
  // The address moved within its origin (a path, a query): only if one app is there.
  const sameOrigin = tiles.filter(
    (tile) => tile.machineApp !== null && belongsToComputer(item.target, [tile.openUrl]),
  );
  return sameOrigin.length === 1 ? sameOrigin[0]!.machineApp : null;
}

export function usePinnedApp(item: UnoPin): {
  readonly app: UnoMachineApp | null;
  readonly environmentId: EnvironmentId | null;
} {
  const { tiles } = useProgramTiles();
  const machine = useActiveMachine();
  return { app: pinnedMachineApp(item, tiles), environmentId: machine.environmentId };
}

/** Only one card at a time: opening one closes the one before. */
let closeOpenPeek: (() => void) | null = null;

export interface PeekHover {
  readonly open: boolean;
  /** Ever shown: keep it mounted (hidden) from then on. */
  readonly shown: boolean;
  readonly anchor: DOMRect | null;
  readonly triggerProps: {
    readonly onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
    readonly onPointerLeave: () => void;
  };
  readonly peekRef: (element: HTMLElement | null) => void;
  readonly close: () => void;
}

/**
 * Once a card is open, the pointer's place on the page decides when it goes:
 * React's enter/leave can't tell (the card is portalled out of the pin, and
 * the widget's iframe swallows the pointer), so every move outside both the
 * pin and the card starts the close.
 */
export function usePeekHover(enabled: boolean): PeekHover {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const peek = useRef<HTMLElement | null>(null);

  const cancelOpen = () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = useCallback(() => {
    cancelOpen();
    cancelClose();
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const scheduleClose = () => {
      if (closeTimer.current !== null) return;
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setOpen(false);
      }, CLOSE_DELAY_MS);
    };
    const onMove = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      const inside =
        target !== null &&
        (trigger.current?.contains(target) === true || peek.current?.contains(target) === true);
      if (inside) cancelClose();
      else scheduleClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const root = document.documentElement;
    document.addEventListener("pointermove", onMove);
    root.addEventListener("pointerleave", scheduleClose);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", scheduleClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
      if (closeOpenPeek === close) closeOpenPeek = null;
    },
    [close],
  );
  useEffect(() => {
    if (!enabled) close();
  }, [enabled, close]);

  return {
    open: open && enabled,
    shown,
    anchor,
    close,
    peekRef: (element) => {
      peek.current = element;
    },
    triggerProps: {
      onPointerEnter: (event) => {
        // A finger has no hover: a tap opens the pin, no card.
        if (!enabled || event.pointerType === "touch") return;
        trigger.current = event.currentTarget;
        cancelClose();
        if (open || openTimer.current !== null) return;
        const rect = event.currentTarget.getBoundingClientRect();
        openTimer.current = window.setTimeout(() => {
          openTimer.current = null;
          if (closeOpenPeek && closeOpenPeek !== close) closeOpenPeek();
          closeOpenPeek = close;
          setAnchor(rect);
          setShown(true);
          setOpen(true);
        }, OPEN_DELAY_MS);
      },
      // Left before it opened: never mind. After, the page-wide watch above decides.
      onPointerLeave: cancelOpen,
    },
  };
}

/**
 * Where a card of `width`×`height` goes: right of the pin's row, kept inside
 * the window — or nowhere, when a narrow window has no room beside the
 * sidebar (a card over the pins would hide what it's about).
 */
function placeBeside(anchor: DOMRect, width: number, height: number) {
  const left = anchor.right + 10;
  if (left + width + 8 > window.innerWidth) return null;
  const top = Math.max(8, Math.min(anchor.top - 10, window.innerHeight - height - 8));
  return { left, top, width, height };
}

function PeekShell(props: {
  readonly hover: PeekHover;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly children: ReactNode;
}) {
  const { hover } = props;
  if (!hover.shown || !hover.anchor || typeof document === "undefined") return null;
  const place = placeBeside(hover.anchor, props.width, props.height);
  if (!place) return null;
  return createPortal(
    <div
      role="dialog"
      aria-label={props.label}
      aria-hidden={!hover.open}
      data-testid="pin-peek-card"
      data-open={hover.open ? "true" : "false"}
      ref={hover.peekRef}
      style={{ left: place.left, top: place.top, width: place.width, height: place.height }}
      className={cn(
        "fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl transition-[opacity,transform] duration-150 ease-out",
        hover.open ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-1 opacity-0",
      )}
    >
      {props.children}
    </div>,
    document.body,
  );
}

const WIDGET_HEIGHT = { small: 180, medium: 200, wide: 220 } as const;

/** The app's Home widget, as on Home, in a card beside its pin. */
export function PinWidgetPeek(props: {
  readonly hover: PeekHover;
  readonly app: UnoMachineApp;
  readonly environmentId: EnvironmentId | null;
  readonly onOpen: () => void;
}) {
  const widget = props.app.widget;
  if (!widget) return null;
  const width = widget.size === "wide" ? 420 : 340;
  const height = 40 + WIDGET_HEIGHT[widget.size] + 20;
  return (
    <PeekShell hover={props.hover} width={width} height={height} label={`${props.app.name} widget`}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 pr-1.5 pl-3">
        <ProgramIcon
          name={props.app.name}
          icon={props.app.icon ?? null}
          iconImage={props.app.iconImage ?? null}
          className="size-5 rounded-md text-[13px] leading-none shadow-none ring-0"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {widget.title ?? props.app.name}
        </span>
        <button
          type="button"
          onClick={() => {
            props.hover.close();
            props.onOpen();
          }}
          className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground hover:bg-accent"
          data-testid="pin-peek-open"
        >
          Open
          <ArrowUpRightIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 px-2.5 py-2.5">
        <HomeAppWidget app={props.app} environmentId={props.environmentId} />
      </div>
    </PeekShell>
  );
}
