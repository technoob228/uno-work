/**
 * An app's own Home widget (manifest `widget`, App SDK): the app's page at the
 * widget's path in a small sandboxed frame. The frame never shares Uno Work's
 * origin (see `appWidgetSandbox`), can't navigate Work, and reloads when the
 * window gets focus so a glance is fresh.
 *
 * An app only its cloud computer reaches is shown from the port's address
 * (P16, 28.10 — `homeAppWidget.logic.ts`), like "Your site" in the panel:
 * the widget works inside Uno Work by default, nothing to publish.
 */
import type { EnvironmentId, UnoMachineApp } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import { useOpenApp } from "../../../navigation/useOpenApp";
import { useCloudComputer, usePortFrame } from "../../preview/portPreview";
import { Spinner } from "../../ui/spinner";
import { isBrowserOnMachine, machineAppOpenUrl } from "../programModel";
import { homeWidgetSource } from "./homeAppWidget.logic";
import { appWidgetSandbox } from "./homeLayout";

const HEIGHT: Record<"small" | "medium" | "wide", string> = {
  small: "h-[180px]",
  medium: "h-[200px]",
  wide: "h-[220px]",
};

/** Bumps on window focus (at most every 10 s), so widgets reload when the person comes back. */
function useFocusTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < 10_000) return;
      last = Date.now();
      setTick((value) => value + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return tick;
}

export function HomeAppWidget({
  app,
  environmentId,
}: {
  app: UnoMachineApp;
  environmentId: EnvironmentId | null;
}) {
  const tick = useFocusTick();
  const computer = useCloudComputer(environmentId);
  const source = homeWidgetSource(app, {
    browserOnMachine: isBrowserOnMachine(window.location.hostname),
    cloudComputer: computer !== null,
  });
  const port = usePortFrame({
    localUrl: source?.kind === "port" ? source.localUrl : null,
    computer,
  });
  // The port's one-time link is spent by the frame's first load; later loads
  // (focus reloads) go to the port's address itself. Remembered: which link
  // and the focus tick it was first shown at.
  const firstShown = useRef<{ readonly firstSrc: string; readonly tick: number } | null>(null);
  const widget = app.widget;
  if (!widget || !source) return null;
  const height = HEIGHT[widget.size];

  if (source.kind === "none") {
    return (
      <p className="text-xs text-muted-foreground">
        {source.why === "stopped"
          ? `Start ${app.name} to see its widget.`
          : `${app.name} has no page to show here.`}
      </p>
    );
  }
  if (source.kind === "port" && port.state.kind !== "ready") {
    if (port.state.kind === "failed") {
      return (
        <div
          className={cn(
            "flex flex-col items-start justify-center gap-2 text-xs text-muted-foreground",
            height,
          )}
          data-testid={`app-widget-unavailable-${app.id}`}
        >
          <p>
            {port.state.reason === "disabled"
              ? `${app.name} is running, but this account can't show widgets of the cloud computer here yet.`
              : `${app.name} is running, but Uno Work couldn't reach it from this browser.`}
          </p>
          <button
            type="button"
            onClick={port.retry}
            className="font-medium text-foreground hover:underline"
          >
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className={cn("flex items-center justify-center", height)}>
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );
  }
  const ready = source.kind === "port" && port.state.kind === "ready" ? port.state : null;
  if (ready && firstShown.current?.firstSrc !== ready.firstSrc) {
    firstShown.current = { firstSrc: ready.firstSrc, tick };
  }
  const src = ready
    ? firstShown.current?.tick === tick
      ? ready.firstSrc
      : ready.url
    : source.kind === "direct"
      ? source.url
      : null;
  if (!src) return null;
  // The desktop app: a webview (the port's address lets only Work's own
  // https addresses frame it; the desktop's page is on 127.0.0.1).
  if (ready && isElectron) {
    return (
      <webview
        key={`${ready.firstSrc}#${tick}`}
        src={src}
        partition="persist:uno-apps"
        className={cn("w-full rounded-lg", height)}
        style={{ display: "flex" }}
        data-testid={`app-widget-frame-${app.id}`}
      />
    );
  }
  return (
    <iframe
      key={`${ready ? ready.firstSrc : src}#${tick}`}
      src={src}
      title={widget.title ?? app.name}
      sandbox={appWidgetSandbox(src, window.location.origin)}
      referrerPolicy="strict-origin-when-cross-origin"
      // A port's one-time link lives a minute: load it now, not on scroll.
      loading={ready ? "eager" : "lazy"}
      className={cn("w-full rounded-lg border-0 bg-transparent", height)}
      data-testid={`app-widget-frame-${app.id}`}
    />
  );
}

/** "Open" next to the widget's title: the whole app inside Uno. */
export function HomeAppWidgetOpen({
  app,
  environmentId,
}: {
  app: UnoMachineApp;
  environmentId: EnvironmentId | null;
}) {
  const { openHere, openComputerApp } = useOpenApp();
  const computer = useCloudComputer(environmentId);
  // A cloud computer's localhost is never this device's.
  const base = machineAppOpenUrl(
    app,
    isBrowserOnMachine(window.location.hostname) && computer === null,
  );
  // An app only the computer reaches opens in its window by its tile (the
  // window shows it from the port's address).
  const onComputer = !base && app.status === "running" && app.http && app.port !== null;
  if (!base && !onComputer) return null;
  return (
    <button
      type="button"
      onClick={() =>
        base
          ? openHere({ url: base, name: app.name, icon: app.icon })
          : openComputerApp({ key: app.id, name: app.name, icon: app.icon })
      }
      className="flex items-center gap-1 hover:text-foreground"
    >
      Open
      <ExternalLinkIcon className="size-3" />
    </button>
  );
}
