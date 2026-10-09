/**
 * An app's own Home widget (manifest `widget`, App SDK): the app's page at the
 * widget's path in a small sandboxed frame. The frame never shares Uno Work's
 * origin (see `appWidgetSandbox`), can't navigate Work, and reloads when the
 * window gets focus so a glance is fresh.
 */
import type { UnoMachineApp } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import { useOpenApp } from "../../../navigation/useOpenApp";
import {
  appWidgetMissingText,
  isBrowserOnMachine,
  machineAppOpenUrl,
  machineAppWidgetBase,
} from "../programModel";
import { appWidgetSandbox, appWidgetUrl } from "./homeLayout";

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

/**
 * `workBaseUrl`: the daemon's http address. From a browser on another device
 * the widget comes through it (`/_apps/<id>/<token>/…`, https like Work), so
 * the app needn't be on the internet.
 */
export function HomeAppWidget({
  app,
  workBaseUrl,
}: {
  app: UnoMachineApp;
  workBaseUrl: string | null;
}) {
  const tick = useFocusTick();
  const widget = app.widget;
  const base = machineAppWidgetBase(app, isBrowserOnMachine(window.location.hostname), workBaseUrl);
  const src = widget && base ? appWidgetUrl(base, widget.path) : null;
  if (!widget) return null;
  if (!src) {
    return <p className="text-xs text-muted-foreground">{appWidgetMissingText(app)}</p>;
  }
  return (
    <iframe
      key={`${src}#${tick}`}
      src={src}
      title={widget.title ?? app.name}
      sandbox={appWidgetSandbox(src, window.location.origin)}
      referrerPolicy="strict-origin-when-cross-origin"
      loading="lazy"
      className={cn("w-full rounded-lg border-0 bg-transparent", HEIGHT[widget.size])}
      data-testid={`app-widget-frame-${app.id}`}
    />
  );
}

/** "Open" next to the widget's title: the whole app inside Uno. */
export function HomeAppWidgetOpen({
  app,
  workBaseUrl,
}: {
  app: UnoMachineApp;
  workBaseUrl: string | null;
}) {
  const { openHere } = useOpenApp();
  const base = machineAppOpenUrl(app, isBrowserOnMachine(window.location.hostname), workBaseUrl);
  if (!base) return null;
  return (
    <button
      type="button"
      onClick={() => openHere({ url: base, name: app.name, icon: app.icon })}
      className="flex items-center gap-1 hover:text-foreground"
    >
      Open
      <ExternalLinkIcon className="size-3" />
    </button>
  );
}
