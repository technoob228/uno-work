/**
 * `/app?url=…&name=…` — one of the computer's apps, open inside Uno Work.
 *
 * The bar above the app keeps the way back and the ways out in one place:
 * Home (the computer's desktop), the app's name and address, then Reload,
 * Pin, "Beside a chat" (moves it to the right panel next to your last chat),
 * "New tab" and "Full screen". Full screen covers the whole window and leaves
 * a small pill with Home and "Exit full screen" — never a dead end.
 *
 * Only addresses of this computer's apps (or pinned apps) are framed: a
 * crafted link can't dress an arbitrary site in Uno's chrome.
 */
import { getRouteApi } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  HouseIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightIcon,
  PinIcon,
  PinOffIcon,
  RotateCwIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useNavStore } from "../../navigation/navStore";
import { useGoHome } from "../../navigation/useGoHome";
import { useOpenApp } from "../../navigation/useOpenApp";
import { usePins } from "../../navigation/usePins";
import { ProgramIcon } from "../computer/ComputerPrograms";
import { useProgramTiles } from "../computer/useProgramTiles";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AppFrame } from "./AppFrame";
import { appHost, belongsToComputer } from "./appAddress";

const routeApi = getRouteApi("/_chat/app");

export function AppView() {
  const search = routeApi.useSearch();
  const url = search.url ?? null;
  const name = search.name?.trim() || (url ? appHost(url) : "App");
  const { tiles, loading } = useProgramTiles();
  const { pins, isPinned, toggle } = usePins();
  const { openBeside, openInNewTab } = useOpenApp();
  const goHome = useGoHome();
  const fullscreen = useNavStore((state) => state.appFullscreen);
  const setFullscreen = useNavStore((state) => state.setAppFullscreen);
  const [reloadKey, setReloadKey] = useState(0);

  const tile = useMemo(() => {
    if (!url) return null;
    return tiles.find((candidate) => belongsToComputer(url, [candidate.openUrl])) ?? null;
  }, [tiles, url]);
  const icon = search.icon ?? tile?.icon ?? null;
  const known = useMemo(
    () =>
      url !== null &&
      belongsToComputer(url, [
        ...tiles.map((candidate) => candidate.openUrl),
        ...pins.filter((pin) => pin.kind === "app").map((pin) => pin.target),
      ]),
    [pins, tiles, url],
  );

  // Leaving the app (Home, another screen) always ends full screen.
  useEffect(() => () => setFullscreen(false), [setFullscreen]);

  const pinned = url ? isPinned("app", url) : false;
  const app = url ? { url, name, icon } : null;

  const frame = !url ? (
    <Notice title="No app to open">Pick an app in the sidebar or on your Home screen.</Notice>
  ) : !known && loading ? (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  ) : !known ? (
    <Notice title="This address isn't one of this computer's apps">
      Uno Work only shows this computer's own apps inside it. You can still open{" "}
      <span className="font-mono text-foreground">{appHost(url)}</span> in a new browser tab.
      <div className="mt-4">
        <Button variant="outline" onClick={() => openInNewTab(url)}>
          <ExternalLinkIcon />
          Open in a new tab
        </Button>
      </div>
    </Notice>
  ) : (
    <AppFrame url={url} name={name} icon={icon} reloadKey={reloadKey} />
  );

  if (fullscreen && app && known) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background">
        <div className="fixed inset-0 z-50 bg-background">
          {frame}
          <div className="pointer-events-auto absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border bg-popover/95 p-1 shadow-lg backdrop-blur">
            <PillButton label="Home" onClick={goHome}>
              <HouseIcon />
            </PillButton>
            <span className="flex items-center gap-1.5 px-1.5 text-xs font-medium text-foreground">
              <ProgramIcon
                name={name}
                icon={icon}
                iconImage={tile?.iconImage ?? null}
                className="size-5 rounded-md text-xs shadow-none ring-0"
              />
              <span className="max-w-[10rem] truncate">{name}</span>
            </span>
            <PillButton label="Open in a new tab" onClick={() => openInNewTab(app.url)}>
              <ExternalLinkIcon />
            </PillButton>
            <PillButton label="Exit full screen" onClick={() => setFullscreen(false)}>
              <Minimize2Icon />
            </PillButton>
          </div>
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="drag-region flex h-[52px] shrink-0 items-center gap-1 border-b border-border px-2 sm:gap-1.5 sm:px-3 wco:h-[env(titlebar-area-height)]">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <Button
            size="xs"
            variant="ghost"
            onClick={goHome}
            className="shrink-0 [-webkit-app-region:no-drag]"
            aria-label="Home"
          >
            <HouseIcon />
            <span className="max-sm:hidden">Home</span>
          </Button>
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          <ProgramIcon
            name={name}
            icon={icon}
            iconImage={tile?.iconImage ?? null}
            className="size-7 rounded-lg text-base shadow-none"
          />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-foreground">{name}</div>
            {url ? (
              <div className="truncate font-mono text-[11px] text-muted-foreground max-sm:hidden">
                {appHost(url)}
              </div>
            ) : null}
          </div>
          {app && known ? (
            <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
              <BarButton label="Reload" onClick={() => setReloadKey((key) => key + 1)}>
                <RotateCwIcon />
              </BarButton>
              <BarButton
                label={pinned ? "Unpin from the sidebar" : "Pin to the sidebar"}
                active={pinned}
                onClick={() =>
                  toggle({ kind: "app", title: name, target: app.url, icon: icon ?? null })
                }
              >
                {pinned ? <PinOffIcon /> : <PinIcon />}
              </BarButton>
              <BarButton
                label="Open beside a chat"
                className="max-md:hidden"
                onClick={() => openBeside(app)}
              >
                <PanelRightIcon />
              </BarButton>
              <BarButton
                label="Open in a new tab (if the app can't keep you signed in here)"
                onClick={() => openInNewTab(app.url)}
              >
                <ExternalLinkIcon />
              </BarButton>
              <BarButton label="Full screen" onClick={() => setFullscreen(true)}>
                <Maximize2Icon />
              </BarButton>
            </div>
          ) : null}
        </header>
        <div className="relative min-h-0 flex-1">{frame}</div>
      </div>
    </SidebarInset>
  );
}

function BarButton({
  label,
  onClick,
  active,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
            className={cn(active && "text-primary", className)}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function PillButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <div className="mt-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}
