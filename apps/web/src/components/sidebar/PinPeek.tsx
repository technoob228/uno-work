/**
 * Prototype 29.10 (Misha): a glance at a pinned app without leaving the page.
 * Hover a pinned app and beside the sidebar shows
 *   - `card`: its Home widget (manifest `widget`) — only apps that have one;
 *   - `window`: the app itself in a small window — any app.
 * The peek stays while the pointer is on the pin or on the peek, so its
 * buttons can be pressed; it closes a moment after the pointer leaves both,
 * on Escape, or when the pin is clicked. Once shown, a peek stays mounted
 * (hidden): the next glance is instant, the widget doesn't load again.
 */
import type { EnvironmentId, UnoMachineApp, UnoPin } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRightIcon, PanelRightIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { cn } from "../../lib/utils";
import { useOpenApp } from "../../navigation/useOpenApp";
import { ProgramIcon } from "../computer/ComputerPrograms";
import { machineAppsQueryOptions } from "../computer/computerQueries";
import { HomeAppWidget } from "../computer/home/HomeAppWidget";
import { appWidgetSandbox } from "../computer/home/homeLayout";
import { machineAppOpenUrl } from "../computer/programModel";
import type { PeekVariant } from "./sidebarProto";

const OPEN_DELAY_MS: Record<Exclude<PeekVariant, "off">, number> = { card: 300, window: 450 };
const CLOSE_DELAY_MS = 180;

/** The app a pin opens, from this computer's apps (pins keep the app's address). */
export function usePinnedApp(item: UnoPin): {
  readonly app: UnoMachineApp | null;
  readonly environmentId: EnvironmentId | null;
} {
  const environmentId = usePrimaryEnvironmentId();
  const apps = useQuery(machineAppsQueryOptions(environmentId, item.kind === "app"));
  const app =
    item.kind === "app"
      ? (apps.data?.apps.find(
          (candidate) =>
            candidate.url === item.target || machineAppOpenUrl(candidate, false) === item.target,
        ) ?? null)
      : null;
  return { app, environmentId };
}

/** Only one peek at a time: opening one closes the one before. */
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
 * Once a peek is open, the pointer's place on the page decides when it goes:
 * React's enter/leave can't tell (the peek is portalled out of the pin, and
 * the window peek's iframe swallows the pointer), so every move outside both
 * the pin and the peek starts the close.
 */
export function usePeekHover(variant: PeekVariant, enabled: boolean): PeekHover {
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
      if (closeTimer.current === null) {
        closeTimer.current = window.setTimeout(() => {
          closeTimer.current = null;
          setOpen(false);
        }, CLOSE_DELAY_MS);
      }
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
    },
    [],
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
        if (!enabled || variant === "off") return;
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
        }, OPEN_DELAY_MS[variant]);
      },
      // Left before it opened: never mind. After, the page-wide watch above decides.
      onPointerLeave: cancelOpen,
    },
  };
}

/** Where a peek of `width`×`height` goes: right of the pin's row, kept inside the window. */
function placeBeside(anchor: DOMRect, width: number, height: number) {
  const left = Math.min(anchor.right + 10, window.innerWidth - width - 8);
  const top = Math.max(8, Math.min(anchor.top - 10, window.innerHeight - height - 8));
  return { left, top, width, height };
}

function PeekShell(props: {
  readonly hover: PeekHover;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const { hover } = props;
  if (!hover.shown || !hover.anchor || typeof document === "undefined") return null;
  const place = placeBeside(hover.anchor, props.width, props.height);
  return createPortal(
    <div
      role="dialog"
      aria-label={props.label}
      aria-hidden={!hover.open}
      data-testid={props.testId}
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

function PeekHeader(props: {
  readonly app: UnoMachineApp;
  readonly title: string;
  readonly onOpen: () => void;
  readonly onBeside?: () => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 pr-1.5 pl-3">
      <ProgramIcon
        name={props.app.name}
        icon={props.app.icon ?? null}
        iconImage={props.app.iconImage ?? null}
        className="size-5 rounded-md text-[13px] leading-none shadow-none ring-0"
      />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">{props.title}</span>
      {props.onBeside ? (
        <button
          type="button"
          onClick={props.onBeside}
          aria-label="Open beside the chat"
          title="Open beside the chat"
          className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelRightIcon className="size-4" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={props.onOpen}
        className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground hover:bg-accent"
        data-testid="pin-peek-open"
      >
        Open
        <ArrowUpRightIcon className="size-3.5" />
      </button>
    </div>
  );
}

const WIDGET_HEIGHT = { small: 180, medium: 200, wide: 220 } as const;

/** `card`: the app's Home widget, as on Home, in a card beside the pin. */
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
    <PeekShell
      hover={props.hover}
      width={width}
      height={height}
      label={`${props.app.name} widget`}
      testId="pin-peek-card"
    >
      <PeekHeader
        app={props.app}
        title={widget.title ?? props.app.name}
        onOpen={() => {
          props.hover.close();
          props.onOpen();
        }}
      />
      <div className="min-h-0 flex-1 px-2.5 py-2.5">
        <HomeAppWidget app={props.app} environmentId={props.environmentId} />
      </div>
    </PeekShell>
  );
}

/** `window`: the app itself in a small window beside the sidebar. */
export function PinWindowPeek(props: {
  readonly hover: PeekHover;
  readonly app: UnoMachineApp;
  readonly onOpen: () => void;
}) {
  const { openBeside } = useOpenApp();
  const src = machineAppOpenUrl(props.app, false);
  if (!src) return null;
  const width = Math.min(760, Math.round(window.innerWidth * 0.5));
  const height = Math.min(560, Math.round(window.innerHeight * 0.72));
  return (
    <PeekShell
      hover={props.hover}
      width={width}
      height={height}
      label={props.app.name}
      testId="pin-peek-window"
    >
      <PeekHeader
        app={props.app}
        title={props.app.name}
        onOpen={() => {
          props.hover.close();
          props.onOpen();
        }}
        onBeside={() => {
          props.hover.close();
          openBeside({ url: src, name: props.app.name, icon: props.app.icon ?? null });
        }}
      />
      <iframe
        src={src}
        title={props.app.name}
        sandbox={appWidgetSandbox(src, window.location.origin)}
        referrerPolicy="strict-origin-when-cross-origin"
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    </PeekShell>
  );
}
