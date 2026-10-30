/**
 * Apps and widgets as icons, in a thin row of their own under the places. The
 * row of places has no room for them: with Automations and Dev mode two more
 * icons fit, and every name that grows on hover would turn into a tooltip. So
 * this row shows only when something is pinned, and what doesn't fit goes under
 * More.
 *
 * A click opens what the person came for: the widget, in a card under the icon.
 * An app without a widget opens as usual; its card has Open for the rest.
 */
import type { EnvironmentId, UnoMachineApp, UnoPin } from "@t3tools/contracts";
import { ArrowUpRightIcon, MoreHorizontalIcon, PinOffIcon } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { pinnedWidgetId, splitRowPins } from "../../navigation/pins";
import { usePins } from "../../navigation/usePins";
import { HomeAppWidget } from "../computer/home/HomeAppWidget";
import {
  AiSpendWidget,
  CloudWidget,
  PlanLimitsWidget,
  SitesWidget,
} from "../computer/home/HomeWidgetBodies";
import { HOME_WIDGETS } from "../computer/home/HomeWidgets";
import { isPinnableHomeWidget, type PinnableHomeWidgetId } from "../computer/home/homeModel";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePinnedApp } from "./PinPeek";
import { PinIcon, useAppPinsInRow, useOpenPin, usePinActive } from "./SidebarPinned";

const ICON_CLASS =
  "relative grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg text-sidebar-foreground/70 outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 data-[popup-open]:bg-sidebar-row-hover";

function PinnedWidgetBody(props: {
  readonly id: PinnableHomeWidgetId;
  readonly environmentId: EnvironmentId | null;
}) {
  switch (props.id) {
    case "plan-limits":
      return <PlanLimitsWidget environmentId={props.environmentId} />;
    case "ai-spend":
      return <AiSpendWidget environmentId={props.environmentId} />;
    case "cloud":
      return <CloudWidget environmentId={props.environmentId} />;
    case "sites":
      return <SitesWidget />;
  }
}

function PinCard(props: {
  readonly item: UnoPin;
  readonly app: UnoMachineApp | null;
  readonly environmentId: EnvironmentId | null;
  readonly widgetId: PinnableHomeWidgetId | null;
  readonly onOpen: () => void;
  readonly onUnpin: () => void;
}) {
  const { item, app, environmentId, widgetId } = props;
  return (
    <div className="flex flex-col gap-3" data-testid="pin-row-card">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground">
          <PinIcon item={item} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{item.title}</span>
        {app ? (
          <button
            type="button"
            onClick={props.onOpen}
            data-testid="pin-row-open"
            className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground hover:bg-accent"
          >
            Open
            <ArrowUpRightIcon className="size-3.5" />
          </button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Unpin ${item.title}`}
                onClick={props.onUnpin}
                className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              />
            }
          >
            <PinOffIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Unpin</TooltipPopup>
        </Tooltip>
      </div>
      {widgetId !== null ? (
        <PinnedWidgetBody id={widgetId} environmentId={environmentId} />
      ) : app ? (
        <div className="h-44">
          <HomeAppWidget app={app} environmentId={environmentId} />
        </div>
      ) : null}
    </div>
  );
}

function usePinCard(item: UnoPin) {
  const { app } = usePinnedApp(item);
  const { environmentId } = useActiveMachine();
  const rawWidgetId = pinnedWidgetId(item);
  const widgetId = isPinnableHomeWidget(rawWidgetId) ? rawWidgetId : null;
  const appWithWidget = app?.widget ? app : null;
  return {
    environmentId,
    widgetId,
    app: appWithWidget,
    hasCard: widgetId !== null || appWithWidget !== null,
  };
}

const PinButton = memo(function PinButton({ item }: { item: UnoPin }) {
  const { unpin } = usePins();
  const openPin = useOpenPin();
  const active = usePinActive(item);
  const { environmentId, widgetId, app, hasCard } = usePinCard(item);
  const [open, setOpen] = useState(false);
  const { isMobile, setOpenMobile } = useSidebar();

  const showMenu = async (position: { x: number; y: number }) => {
    const choice = await readLocalApi()?.contextMenu.show(
      [{ id: "unpin" as const, label: "Unpin", destructive: true }],
      position,
    );
    if (choice === "unpin") unpin(item.id);
  };
  const shared = {
    "aria-label": item.title,
    "data-testid": `pin-row-${item.id}`,
    "aria-current": active ? ("page" as const) : undefined,
    onContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
      event.preventDefault();
      void showMenu({ x: event.clientX, y: event.clientY });
    },
    className: cn(ICON_CLASS, active && "bg-sidebar-row-active text-foreground"),
  };

  if (!hasCard) {
    return (
      <Tooltip>
        <TooltipTrigger render={<button type="button" {...shared} onClick={() => openPin(item)} />}>
          <PinIcon item={item} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{item.title}</TooltipPopup>
      </Tooltip>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger render={<PopoverTrigger {...shared} />}>
          <PinIcon item={item} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{item.title}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="start" className="w-[min(24rem,calc(100vw-1.5rem))]">
        <PinCard
          item={item}
          app={app}
          environmentId={environmentId}
          widgetId={widgetId}
          onOpen={() => {
            setOpen(false);
            if (isMobile) setOpenMobile(false);
            openPin(item);
          }}
          onUnpin={() => {
            setOpen(false);
            unpin(item.id);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
});

function MorePinRow({ item, onChoose }: { item: UnoPin; onChoose: (item: UnoPin) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChoose(item)}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-sm hover:bg-accent"
    >
      <span className="text-muted-foreground">
        <PinIcon item={item} />
      </span>
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
    </button>
  );
}

function MoreCard({ item, onDone }: { item: UnoPin; onDone: () => void }) {
  const { unpin } = usePins();
  const openPin = useOpenPin();
  const { environmentId, widgetId, app } = usePinCard(item);
  return (
    <PinCard
      item={item}
      app={app}
      environmentId={environmentId}
      widgetId={widgetId}
      onOpen={() => {
        onDone();
        openPin(item);
      }}
      onUnpin={() => {
        onDone();
        unpin(item.id);
      }}
    />
  );
}

function ChooseFromMore(props: {
  readonly rest: ReadonlyArray<UnoPin>;
  readonly onChoose: (item: UnoPin) => void;
}) {
  return (
    <div className="flex flex-col gap-px" data-testid="pin-row-more-list">
      {props.rest.map((item) => (
        <MorePinRow key={item.id} item={item} onChoose={props.onChoose} />
      ))}
    </div>
  );
}

/** A pin under More: one with a card shows it right here. */
function MorePins({ rest }: { rest: ReadonlyArray<UnoPin> }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<UnoPin | null>(null);
  const openPin = useOpenPin();
  const close = () => {
    setOpen(false);
    setChosen(null);
  };
  const choose = (item: UnoPin) => {
    if (pinnedWidgetId(item) !== null) {
      setChosen(item);
      return;
    }
    close();
    openPin(item);
  };
  let body: ReactNode = <ChooseFromMore rest={rest} onChoose={choose} />;
  if (chosen) body = <MoreCard item={chosen} onDone={close} />;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setChosen(null);
      }}
    >
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label="More pins"
              data-testid="pin-row-more"
              className={ICON_CLASS}
            />
          }
        >
          <MoreHorizontalIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">More pins</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" className="w-[min(24rem,calc(100vw-1.5rem))]">
        {body}
      </PopoverPopup>
    </Popover>
  );
}

export const SidebarPinRow = memo(function SidebarPinRow() {
  const { pins } = usePins();
  const inRow = useAppPinsInRow();
  const appPins = useMemo(() => pins.filter((item) => item.kind === "app"), [pins]);
  const row = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(236);
  const visible = inRow && appPins.length > 0;
  useLayoutEffect(() => {
    const nav = row.current;
    if (!nav) return;
    setWidth(nav.clientWidth);
    const observer = new ResizeObserver(() => setWidth(nav.clientWidth));
    observer.observe(nav);
    return () => observer.disconnect();
  }, [visible]);
  if (!visible) return null;
  const { shown, rest } = splitRowPins(appPins, width);
  return (
    <nav
      ref={row}
      aria-label="Pinned apps and widgets"
      className="flex w-full min-w-0 items-center gap-0.5 px-0.5 pt-0.5"
      data-testid="sidebar-pin-row"
    >
      {shown.map((item) => (
        <PinButton key={item.id} item={item} />
      ))}
      {rest.length > 0 ? <MorePins rest={rest} /> : null}
    </nav>
  );
});
